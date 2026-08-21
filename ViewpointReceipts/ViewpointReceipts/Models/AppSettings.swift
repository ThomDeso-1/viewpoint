import Foundation
import Observation

// MARK: - Storage Location

enum StorageLocation: String, CaseIterable {
    case device  = "device"
    case icloud  = "icloud"

    var displayName: String {
        switch self {
        case .device: return "On My iPhone"
        case .icloud: return "iCloud Drive"
        }
    }
}

// MARK: - App Settings

/// Persists user preferences in UserDefaults.
/// Injected into the SwiftUI environment as an @Observable object.
@Observable
final class AppSettings {

    // MARK: Keys

    private enum Keys {
        static let hasCompletedOnboarding = "hasCompletedOnboarding"
        static let storageLocation        = "storageLocation"
        // Phase 2
        static let hasClaudeApiKey        = "hasClaudeApiKey"
        // Phase 3
        static let hasWaveToken           = "hasWaveToken"
        static let waveBusinessId         = "waveBusinessId"
        static let waveBusinessName       = "waveBusinessName"
        static let waveSalesTaxId         = "waveSalesTaxId"
        static let waveExpenseAccountId   = "waveExpenseAccountId"
        static let waveAnchorAccountId    = "waveAnchorAccountId"
    }

    private let defaults = UserDefaults.standard

    // MARK: Phase 1 — Storage & Onboarding

    var hasCompletedOnboarding: Bool {
        didSet { defaults.set(hasCompletedOnboarding, forKey: Keys.hasCompletedOnboarding) }
    }

    var storageLocation: StorageLocation {
        didSet { defaults.set(storageLocation.rawValue, forKey: Keys.storageLocation) }
    }

    // MARK: Phase 2 — Claude API

    var hasClaudeApiKey: Bool {
        didSet { defaults.set(hasClaudeApiKey, forKey: Keys.hasClaudeApiKey) }
    }

    // MARK: Phase 3 — Wave

    var hasWaveToken: Bool {
        didSet { defaults.set(hasWaveToken, forKey: Keys.hasWaveToken) }
    }

    var waveBusinessId: String {
        didSet { defaults.set(waveBusinessId, forKey: Keys.waveBusinessId) }
    }

    var waveBusinessName: String {
        didSet { defaults.set(waveBusinessName, forKey: Keys.waveBusinessName) }
    }

    var waveSalesTaxId: String {
        didSet { defaults.set(waveSalesTaxId, forKey: Keys.waveSalesTaxId) }
    }

    var waveExpenseAccountId: String {
        didSet { defaults.set(waveExpenseAccountId, forKey: Keys.waveExpenseAccountId) }
    }

    var waveAnchorAccountId: String {
        didSet { defaults.set(waveAnchorAccountId, forKey: Keys.waveAnchorAccountId) }
    }

    // MARK: Init

    init() {
        self.hasCompletedOnboarding = UserDefaults.standard.bool(forKey: Keys.hasCompletedOnboarding)
        self.hasClaudeApiKey = UserDefaults.standard.bool(forKey: Keys.hasClaudeApiKey)

        let rawLoc = UserDefaults.standard.string(forKey: Keys.storageLocation) ?? StorageLocation.device.rawValue
        self.storageLocation = StorageLocation(rawValue: rawLoc) ?? .device

        // Phase 3
        self.hasWaveToken         = UserDefaults.standard.bool(forKey: Keys.hasWaveToken)
        self.waveBusinessId       = UserDefaults.standard.string(forKey: Keys.waveBusinessId) ?? ""
        self.waveBusinessName     = UserDefaults.standard.string(forKey: Keys.waveBusinessName) ?? ""
        self.waveSalesTaxId       = UserDefaults.standard.string(forKey: Keys.waveSalesTaxId) ?? ""
        self.waveExpenseAccountId = UserDefaults.standard.string(forKey: Keys.waveExpenseAccountId) ?? ""
        self.waveAnchorAccountId  = UserDefaults.standard.string(forKey: Keys.waveAnchorAccountId) ?? ""
    }
}
