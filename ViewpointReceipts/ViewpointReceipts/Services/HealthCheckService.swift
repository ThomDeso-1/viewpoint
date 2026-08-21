import Foundation
import Observation

// MARK: - Health Check Service

/// Validates API credentials and storage on each app foreground.
/// Exposes a banner message when something is degraded.
@Observable
final class HealthCheckService {

    var bannerMessage: String?
    var isChecking = false

    private let settings: AppSettings

    init(settings: AppSettings) {
        self.settings = settings
    }

    /// Run all health checks. Call on each app foreground.
    func runChecks() async {
        isChecking = true
        defer { isChecking = false }

        // Clear badge on open
        NotificationService.shared.clearBadge()

        var issues: [String] = []

        // Check Wave token
        if settings.hasWaveToken {
            if let token = KeychainService.shared.retrieve(
                forKey: KeychainService.Keys.waveAccessToken
            ) {
                let healthy = await WaveAPIService.shared.checkTokenHealth(token: token)
                if !healthy {
                    issues.append("Wave connection lost — reconnect in Settings")
                    NotificationService.shared.sendTokenExpired(service: "Wave")
                }
            } else {
                issues.append("Wave token missing — reconnect in Settings")
            }
        }

        // Check Claude API key
        if settings.hasClaudeApiKey {
            if let key = KeychainService.shared.retrieve(
                forKey: KeychainService.Keys.claudeApiKey
            ) {
                do {
                    try await ClaudeAPIService.shared.validateApiKey(key)
                } catch {
                    issues.append("Claude API key issue — check Settings")
                }
            } else {
                issues.append("Claude API key missing — add in Settings")
            }
        }

        // Check iCloud availability
        if settings.storageLocation == .icloud {
            if FileManager.default.ubiquityIdentityToken == nil {
                issues.append("iCloud not available — sign in or switch to local storage")
            }
        }

        bannerMessage = issues.isEmpty ? nil : issues.joined(separator: ". ")
    }

    /// Dismiss the banner.
    func dismissBanner() {
        bannerMessage = nil
    }
}
