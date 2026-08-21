import Foundation
import Security

// MARK: - Keychain Service

/// Thin wrapper around the iOS Keychain for storing API credentials securely.
///
/// Each credential is stored as a Generic Password keyed by a service name
/// and the ``Keys`` account identifier, so they don't collide with each other
/// or with anything else on the device.
final class KeychainService {

    static let shared = KeychainService()

    private let service = "com.viewpoint.receipts"

    private init() {}

    // MARK: Account Keys

    enum Keys {
        static let claudeApiKey    = "claudeApiKey"
        static let waveAccessToken = "waveAccessToken"
    }

    // MARK: Errors

    enum KeychainError: LocalizedError {
        case saveFailed(OSStatus)
        case readFailed(OSStatus)
        case deleteFailed(OSStatus)
        case unexpectedData

        var errorDescription: String? {
            switch self {
            case .saveFailed(let status):
                return "Keychain save failed (status \(status))."
            case .readFailed(let status):
                return "Keychain read failed (status \(status))."
            case .deleteFailed(let status):
                return "Keychain delete failed (status \(status))."
            case .unexpectedData:
                return "The keychain returned data in an unexpected format."
            }
        }
    }

    // MARK: Public API

    /// Store or update a string value in the keychain.
    func save(_ value: String, forKey account: String) throws {
        guard let data = value.data(using: .utf8) else { return }

        // Try to update first; if the item doesn't exist yet, add it.
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String:  service,
            kSecAttrAccount as String:  account,
        ]
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]

        var status = SecItemUpdate(query as CFDictionary, update as CFDictionary)

        if status == errSecItemNotFound {
            var addQuery = query
            addQuery[kSecValueData as String] = data
            addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            status = SecItemAdd(addQuery as CFDictionary, nil)
        }

        guard status == errSecSuccess else {
            throw KeychainError.saveFailed(status)
        }
    }

    /// Retrieve a string value from the keychain, or `nil` if not found.
    func retrieve(forKey account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String:  service,
            kSecAttrAccount as String:  account,
            kSecReturnData as String:   true,
            kSecMatchLimit as String:   kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
              let data = result as? Data,
              let string = String(data: data, encoding: .utf8)
        else { return nil }

        return string
    }

    /// Delete a value from the keychain.
    @discardableResult
    func delete(forKey account: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String:  service,
            kSecAttrAccount as String:  account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
