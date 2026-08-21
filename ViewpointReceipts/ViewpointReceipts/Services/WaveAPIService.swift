import Foundation

// MARK: - Wave API Errors

enum WaveAPIError: LocalizedError {
    case noAccessToken
    case invalidToken
    case tokenExpired
    case networkError(Error)
    case serverError(statusCode: Int, message: String)
    case graphQLErrors([String])
    case noBusinessFound
    case transactionRejected(String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .noAccessToken:
            return "No Wave access token found. Add your token in Settings."
        case .invalidToken:
            return "Your Wave access token is invalid. Check your token in Settings."
        case .tokenExpired:
            return "Your Wave access token has expired. Reconnect Wave in Settings."
        case .networkError(let error):
            return "Network error: \(error.localizedDescription)"
        case .serverError(let code, let message):
            return "Wave API error (\(code)): \(message)"
        case .graphQLErrors(let messages):
            return "Wave error: \(messages.joined(separator: "; "))"
        case .noBusinessFound:
            return "No Wave business found on this account."
        case .transactionRejected(let reason):
            return "Wave rejected the transaction: \(reason)"
        case .invalidResponse:
            return "Wave returned an unexpected response."
        }
    }

    /// Whether this error is likely transient and worth retrying.
    var isRetryable: Bool {
        switch self {
        case .networkError, .serverError: return true
        default: return false
        }
    }
}

// MARK: - Wave Data Types

struct WaveBusiness: Identifiable, Codable {
    let id: String
    let name: String
    let isPersonal: Bool
}

struct WaveAccount: Identifiable, Codable {
    let id: String
    let name: String
    let typeName: String
    let subtypeName: String
    let isArchived: Bool
}

struct WaveSalesTax: Identifiable, Codable {
    let id: String
    let name: String
    let rate: Double
}

struct WaveVendor: Identifiable, Codable {
    let id: String
    let name: String
}

struct WaveTransactionResult: Codable {
    let didSucceed: Bool
    let transactionId: String?
    let errors: [String]
}

// MARK: - Wave API Service

/// Communicates with Wave's public GraphQL API.
///
/// Ported from the wave_mcp reference implementation, adapted for
/// direct use from a native iOS app with credentials stored in Keychain.
final class WaveAPIService {

    static let shared = WaveAPIService()

    private let endpoint = URL(string: "https://gql.waveapps.com/graphql/public")!
    private let session: URLSession

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest  = 30
        config.timeoutIntervalForResource = 60
        self.session = URLSession(configuration: config)
    }

    // MARK: - Token Validation

    /// Validate the token by fetching the business list.
    /// Returns the list of businesses on success.
    func validateToken(_ token: String) async throws -> [WaveBusiness] {
        let businesses = try await fetchBusinesses(token: token)
        guard !businesses.isEmpty else { throw WaveAPIError.noBusinessFound }
        return businesses
    }

    // MARK: - Businesses

    func fetchBusinesses(token: String) async throws -> [WaveBusiness] {
        let query = """
        query($page: Int!, $pageSize: Int!) {
            businesses(page: $page, pageSize: $pageSize) {
                edges {
                    node {
                        id
                        name
                        isPersonal
                    }
                }
            }
        }
        """
        let variables: [String: Any] = ["page": 1, "pageSize": 25]
        let data = try await makeRequest(query: query, variables: variables, token: token)

        guard let businesses = data["businesses"] as? [String: Any],
              let edges = businesses["edges"] as? [[String: Any]]
        else { throw WaveAPIError.invalidResponse }

        return edges.compactMap { edge in
            guard let node = edge["node"] as? [String: Any],
                  let id = node["id"] as? String,
                  let name = node["name"] as? String
            else { return nil }
            return WaveBusiness(
                id: id,
                name: name,
                isPersonal: node["isPersonal"] as? Bool ?? false
            )
        }
    }

    // MARK: - Accounts

    /// Fetch all accounts for a business (paginated internally).
    func fetchAccounts(businessId: String, token: String) async throws -> [WaveAccount] {
        var allAccounts: [WaveAccount] = []
        var page = 1

        while true {
            let query = """
            query($businessId: ID!, $page: Int!, $pageSize: Int!) {
                business(id: $businessId) {
                    accounts(page: $page, pageSize: $pageSize) {
                        pageInfo { currentPage totalPages }
                        edges {
                            node {
                                id
                                name
                                type { name }
                                subtype { name }
                                isArchived
                            }
                        }
                    }
                }
            }
            """
            let variables: [String: Any] = [
                "businessId": businessId,
                "page": page,
                "pageSize": 50
            ]
            let data = try await makeRequest(query: query, variables: variables, token: token)

            guard let business = data["business"] as? [String: Any],
                  let accounts = business["accounts"] as? [String: Any],
                  let edges = accounts["edges"] as? [[String: Any]],
                  let pageInfo = accounts["pageInfo"] as? [String: Any]
            else { throw WaveAPIError.invalidResponse }

            for edge in edges {
                guard let node = edge["node"] as? [String: Any],
                      let id = node["id"] as? String,
                      let name = node["name"] as? String,
                      let typeDict = node["type"] as? [String: Any],
                      let typeName = typeDict["name"] as? String,
                      let subtypeDict = node["subtype"] as? [String: Any],
                      let subtypeName = subtypeDict["name"] as? String
                else { continue }

                allAccounts.append(WaveAccount(
                    id: id,
                    name: name,
                    typeName: typeName,
                    subtypeName: subtypeName,
                    isArchived: node["isArchived"] as? Bool ?? false
                ))
            }

            let currentPage = pageInfo["currentPage"] as? Int ?? page
            let totalPages  = pageInfo["totalPages"]  as? Int ?? 1
            if currentPage >= totalPages { break }
            page += 1
            if page > 20 { break } // safety
        }

        return allAccounts
    }

    /// Expense-category accounts (non-archived).
    func fetchExpenseAccounts(businessId: String, token: String) async throws -> [WaveAccount] {
        let all = try await fetchAccounts(businessId: businessId, token: token)
        return all.filter { $0.typeName == "Expenses" && !$0.isArchived }
    }

    /// Bank / credit card accounts that can serve as the "anchor" (payment source).
    func fetchAnchorAccounts(businessId: String, token: String) async throws -> [WaveAccount] {
        let all = try await fetchAccounts(businessId: businessId, token: token)
        let anchorSubtypes: Set<String> = [
            "Cash & Bank", "Credit Card", "Loan and Line of Credit"
        ]
        let anchorTypes: Set<String> = ["Assets", "Liabilities & Credit Cards"]
        return all.filter {
            anchorTypes.contains($0.typeName)
            && anchorSubtypes.contains($0.subtypeName)
            && !$0.isArchived
        }
    }

    // MARK: - Sales Taxes

    func fetchSalesTaxes(businessId: String, token: String) async throws -> [WaveSalesTax] {
        let query = """
        query($businessId: ID!) {
            business(id: $businessId) {
                salesTaxes {
                    edges {
                        node {
                            id
                            name
                            rate
                        }
                    }
                }
            }
        }
        """
        let variables: [String: Any] = ["businessId": businessId]
        let data = try await makeRequest(query: query, variables: variables, token: token)

        guard let business = data["business"] as? [String: Any],
              let salesTaxes = business["salesTaxes"] as? [String: Any],
              let edges = salesTaxes["edges"] as? [[String: Any]]
        else { throw WaveAPIError.invalidResponse }

        return edges.compactMap { edge in
            guard let node = edge["node"] as? [String: Any],
                  let id = node["id"] as? String,
                  let name = node["name"] as? String,
                  let rate = node["rate"] as? Double
            else { return nil }
            return WaveSalesTax(id: id, name: name, rate: rate)
        }
    }

    // MARK: - Vendors

    func fetchVendors(businessId: String, token: String) async throws -> [WaveVendor] {
        let query = """
        query($businessId: ID!) {
            business(id: $businessId) {
                vendors {
                    edges {
                        node {
                            id
                            name
                        }
                    }
                }
            }
        }
        """
        let variables: [String: Any] = ["businessId": businessId]
        let data = try await makeRequest(query: query, variables: variables, token: token)

        guard let business = data["business"] as? [String: Any],
              let vendors = business["vendors"] as? [String: Any],
              let edges = vendors["edges"] as? [[String: Any]]
        else { throw WaveAPIError.invalidResponse }

        return edges.compactMap { edge in
            guard let node = edge["node"] as? [String: Any],
                  let id = node["id"] as? String,
                  let name = node["name"] as? String
            else { return nil }
            return WaveVendor(id: id, name: name)
        }
    }

    /// Case-insensitive search for a vendor by name.
    func findVendor(
        named vendorName: String,
        businessId: String,
        token: String
    ) async throws -> WaveVendor? {
        let vendors = try await fetchVendors(businessId: businessId, token: token)
        return vendors.first { $0.name.localizedCaseInsensitiveCompare(vendorName) == .orderedSame }
    }

    // MARK: - Create Transaction

    /// Create an expense transaction in Wave.
    ///
    /// This mirrors wave_mcp's `create_expense`: an anchor (bank/credit card
    /// withdrawal) and one line item (expense account increase).
    func createExpenseTransaction(
        businessId: String,
        date: String,                      // "YYYY-MM-DD"
        description: String,
        amount: Double,
        expenseAccountId: String,
        anchorAccountId: String,
        salesTaxId: String? = nil,
        token: String
    ) async throws -> WaveTransactionResult {

        let query = """
        mutation($input: MoneyTransactionCreateInput!) {
            moneyTransactionCreate(input: $input) {
                didSucceed
                inputErrors {
                    path
                    message
                    code
                }
                transaction {
                    id
                }
            }
        }
        """

        var lineItem: [String: Any] = [
            "accountId": expenseAccountId,
            "amount": amount,
            "balance": "INCREASE"
        ]

        if let taxId = salesTaxId {
            lineItem["taxes"] = [["salesTaxId": taxId]]
        }

        let input: [String: Any] = [
            "businessId": businessId,
            "externalId": "viewpoint-\(UUID().uuidString.prefix(12).lowercased())",
            "date": date,
            "description": description,
            "anchor": [
                "accountId": anchorAccountId,
                "amount": amount,
                "direction": "WITHDRAWAL"
            ],
            "lineItems": [lineItem]
        ]

        let variables: [String: Any] = ["input": input]
        let data = try await makeRequest(query: query, variables: variables, token: token)

        guard let result = data["moneyTransactionCreate"] as? [String: Any],
              let didSucceed = result["didSucceed"] as? Bool
        else { throw WaveAPIError.invalidResponse }

        if didSucceed {
            let txn = result["transaction"] as? [String: Any]
            let txnId = txn?["id"] as? String
            return WaveTransactionResult(didSucceed: true, transactionId: txnId, errors: [])
        } else {
            let inputErrors = result["inputErrors"] as? [[String: Any]] ?? []
            let messages = inputErrors.compactMap { err -> String? in
                let path = err["path"] as? String ?? ""
                let msg  = err["message"] as? String ?? "Unknown error"
                return path.isEmpty ? msg : "\(path): \(msg)"
            }
            return WaveTransactionResult(didSucceed: false, transactionId: nil, errors: messages)
        }
    }

    // MARK: - Health Check

    /// Quick check that the token is still valid.
    func checkTokenHealth(token: String) async -> Bool {
        do {
            let _ = try await fetchBusinesses(token: token)
            return true
        } catch {
            return false
        }
    }

    // MARK: - GraphQL Transport

    private func makeRequest(
        query: String,
        variables: [String: Any],
        token: String
    ) async throws -> [String: Any] {

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let payload: [String: Any] = [
            "query": query,
            "variables": variables
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let responseData: Data
        let response: URLResponse

        do {
            (responseData, response) = try await session.data(for: request)
        } catch {
            throw WaveAPIError.networkError(error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw WaveAPIError.invalidResponse
        }

        guard http.statusCode == 200 else {
            if http.statusCode == 401 {
                throw WaveAPIError.tokenExpired
            }
            throw WaveAPIError.serverError(
                statusCode: http.statusCode,
                message: HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            )
        }

        guard let json = try? JSONSerialization.jsonObject(with: responseData) as? [String: Any]
        else { throw WaveAPIError.invalidResponse }

        // Check for GraphQL-level errors
        if let errors = json["errors"] as? [[String: Any]] {
            let messages = errors.compactMap { $0["message"] as? String }
            if messages.contains(where: { $0.lowercased().contains("unauthorized") }) {
                throw WaveAPIError.invalidToken
            }
            throw WaveAPIError.graphQLErrors(messages)
        }

        guard let data = json["data"] as? [String: Any] else {
            throw WaveAPIError.invalidResponse
        }

        return data
    }
}
