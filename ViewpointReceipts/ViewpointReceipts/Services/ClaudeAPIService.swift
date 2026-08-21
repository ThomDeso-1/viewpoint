import Foundation
import UIKit

// MARK: - Claude API Errors

enum ClaudeAPIError: LocalizedError {
    case noApiKey
    case invalidApiKey
    case insufficientCredit
    case rateLimited(retryAfter: TimeInterval?)
    case imageEncodingFailed
    case invalidResponse
    case extractionFailed(String)
    case networkError(Error)
    case serverError(statusCode: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .noApiKey:
            return "No Claude API key found. Add your key in Settings."
        case .invalidApiKey:
            return "Your Claude API key is invalid or expired. Check your key in Settings."
        case .insufficientCredit:
            return "Your Claude account needs a top-up — there's no credit remaining."
        case .rateLimited(let retry):
            if let seconds = retry {
                return "Claude API rate limit reached. Retrying in \(Int(seconds)) seconds."
            }
            return "Claude API rate limit reached. Please try again in a moment."
        case .imageEncodingFailed:
            return "Failed to encode the receipt image for the API."
        case .invalidResponse:
            return "Claude returned an unexpected response format."
        case .extractionFailed(let detail):
            return "Could not extract receipt data: \(detail)"
        case .networkError(let error):
            return "Network error: \(error.localizedDescription)"
        case .serverError(let code, let message):
            return "Claude API error (\(code)): \(message)"
        }
    }
}

// MARK: - Claude API Service

/// Sends receipt images to the Claude Messages API (vision) for structured
/// data extraction and validates API keys.
///
/// Uses `claude-sonnet-4-20250514` for extraction (best vision accuracy)
/// and `claude-haiku-3-5-20241022` for lightweight validation calls.
final class ClaudeAPIService {

    static let shared = ClaudeAPIService()

    private let endpoint = URL(string: "https://api.anthropic.com/v1/messages")!
    private let extractionModel  = "claude-sonnet-4-20250514"
    private let validationModel  = "claude-haiku-3-5-20241022"
    private let apiVersion       = "2023-06-01"

    private let session: URLSession

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest  = 60
        config.timeoutIntervalForResource = 120
        self.session = URLSession(configuration: config)
    }

    // MARK: - Key Validation

    /// Send a tiny request to confirm the API key is valid and has credit.
    func validateApiKey(_ apiKey: String) async throws {
        let body: [String: Any] = [
            "model": validationModel,
            "max_tokens": 16,
            "messages": [
                ["role": "user", "content": "Say OK."]
            ]
        ]
        let _ = try await sendRequest(body: body, apiKey: apiKey)
    }

    // MARK: - Receipt Extraction

    /// Extract structured receipt data from one or more page images.
    ///
    /// Returns the parsed ``ExtractionResult`` plus the raw JSON string
    /// for storage in the sidecar file.
    func extractReceipt(
        images: [UIImage],
        apiKey: String
    ) async throws -> (result: ExtractionResult, rawJSON: String) {

        // Build the content array: images first, then the extraction prompt.
        var contentParts: [[String: Any]] = []

        for image in images {
            guard let jpegData = image.jpegData(compressionQuality: 0.8) else {
                throw ClaudeAPIError.imageEncodingFailed
            }
            let base64 = jpegData.base64EncodedString()
            contentParts.append([
                "type": "image",
                "source": [
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": base64
                ]
            ])
        }

        contentParts.append([
            "type": "text",
            "text": Self.extractionPrompt
        ])

        let body: [String: Any] = [
            "model": extractionModel,
            "max_tokens": 1024,
            "messages": [
                ["role": "user", "content": contentParts]
            ]
        ]

        let responseText = try await sendRequest(body: body, apiKey: apiKey)

        // Strip markdown code fences if present: ```json ... ```
        let jsonString = Self.stripCodeFences(responseText)

        guard let jsonData = jsonString.data(using: .utf8) else {
            throw ClaudeAPIError.invalidResponse
        }

        do {
            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase
            let result = try decoder.decode(ExtractionResult.self, from: jsonData)
            return (result, jsonString)
        } catch {
            throw ClaudeAPIError.extractionFailed(
                "Failed to parse extraction JSON: \(error.localizedDescription)"
            )
        }
    }

    // MARK: - Network

    /// Send a request to the Claude Messages API and return the assistant's text.
    private func sendRequest(
        body: [String: Any],
        apiKey: String
    ) async throws -> String {

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue(apiVersion, forHTTPHeaderField: "anthropic-version")

        request.httpBody = try JSONSerialization.data(
            withJSONObject: body, options: []
        )

        let data: Data
        let response: URLResponse

        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw ClaudeAPIError.networkError(error)
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw ClaudeAPIError.invalidResponse
        }

        // Handle error status codes with specific messages
        switch httpResponse.statusCode {
        case 200:
            break // success — continue below

        case 401:
            throw ClaudeAPIError.invalidApiKey

        case 400:
            // Check if this is an out-of-credit error
            if let errorBody = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let errorDict = errorBody["error"] as? [String: Any],
               let message = errorDict["message"] as? String {
                if message.lowercased().contains("credit")
                    || message.lowercased().contains("billing") {
                    throw ClaudeAPIError.insufficientCredit
                }
                throw ClaudeAPIError.serverError(
                    statusCode: 400, message: message
                )
            }
            throw ClaudeAPIError.serverError(
                statusCode: 400, message: "Bad request"
            )

        case 429:
            let retryAfter = httpResponse.value(forHTTPHeaderField: "retry-after")
                .flatMap { TimeInterval($0) }
            throw ClaudeAPIError.rateLimited(retryAfter: retryAfter)

        case 500...599:
            let message: String
            if let errorBody = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let errorDict = errorBody["error"] as? [String: Any],
               let msg = errorDict["message"] as? String {
                message = msg
            } else {
                message = "Server error"
            }
            throw ClaudeAPIError.serverError(
                statusCode: httpResponse.statusCode, message: message
            )

        default:
            throw ClaudeAPIError.serverError(
                statusCode: httpResponse.statusCode,
                message: HTTPURLResponse.localizedString(
                    forStatusCode: httpResponse.statusCode
                )
            )
        }

        // Parse the successful response
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let content = json["content"] as? [[String: Any]],
              let firstBlock = content.first,
              let text = firstBlock["text"] as? String
        else {
            throw ClaudeAPIError.invalidResponse
        }

        return text
    }

    // MARK: - Helpers

    /// Strip ```json ... ``` code fences that Claude sometimes wraps around JSON.
    static func stripCodeFences(_ text: String) -> String {
        var cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)

        // Remove opening fence: ```json or ```
        if cleaned.hasPrefix("```") {
            if let newlineIndex = cleaned.firstIndex(of: "\n") {
                cleaned = String(cleaned[cleaned.index(after: newlineIndex)...])
            }
        }
        // Remove closing fence
        if cleaned.hasSuffix("```") {
            cleaned = String(cleaned.dropLast(3))
        }

        return cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Prompt

    /// The extraction prompt sent alongside receipt images.
    /// Canada-aware: asks for HST/GST/PST breakdowns.
    private static let extractionPrompt = """
    You are a receipt data extraction assistant. Analyze this receipt image \
    and extract the structured data below. Return ONLY valid JSON with no \
    additional text or explanation.

    This is a Canadian business receipt. Look for HST, GST, and/or PST \
    tax breakdowns. If only a single tax line is shown, report it as HST \
    unless the label says otherwise.

    Return this exact JSON structure:
    {
      "receipt_date": "YYYY-MM-DD",
      "vendor": "Store or business name",
      "items": [
        {"description": "Item name or description", "amount": 0.00}
      ],
      "summary_description": "Brief summary of what was purchased",
      "subtotal": 0.00,
      "taxes": [
        {"type": "HST", "rate": 0.13, "amount": 0.00}
      ],
      "total": 0.00,
      "currency": "CAD",
      "confidence": "high"
    }

    Rules:
    - receipt_date: the date printed on the receipt in YYYY-MM-DD format. \
    If unreadable, use today's date.
    - vendor: the business name at the top of the receipt.
    - items: list each line item. If items are unclear, use a single entry \
    with the summary.
    - subtotal: the pre-tax subtotal. If not shown, compute from total - taxes.
    - taxes: break down each tax line (HST, GST, PST). Include the rate as \
    a decimal (e.g. 0.13 for 13%).
    - total: the final amount paid.
    - currency: default to "CAD" unless the receipt shows otherwise.
    - confidence: "high" if all fields are clearly legible, "medium" if some \
    are uncertain, "low" if the image is hard to read.
    """
}
