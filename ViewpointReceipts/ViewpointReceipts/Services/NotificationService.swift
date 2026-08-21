import Foundation
import UserNotifications

// MARK: - Notification Service

/// Handles local push notifications for upload failures and health alerts.
final class NotificationService {

    static let shared = NotificationService()

    private init() {}

    // MARK: - Permission

    /// Request notification permission. Safe to call multiple times.
    func requestPermission() {
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .badge, .sound]
        ) { granted, error in
            if let error {
                print("Notification permission error: \(error.localizedDescription)")
            }
        }
    }

    /// Check if notifications are currently allowed.
    func checkPermission() async -> Bool {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        return settings.authorizationStatus == .authorized
    }

    // MARK: - Upload Failure

    /// Notify the user that a receipt failed to upload after all retries.
    func sendUploadFailure(receiptDescription: String, error: String) {
        let content = UNMutableNotificationContent()
        content.title = "Receipt Upload Failed"
        content.body  = "\(receiptDescription) — \(error). Tap to review."
        content.sound = .default
        content.categoryIdentifier = "UPLOAD_FAILURE"

        let request = UNNotificationRequest(
            identifier: "upload-fail-\(UUID().uuidString.prefix(8))",
            content: content,
            trigger: nil  // deliver immediately
        )
        UNUserNotificationCenter.current().add(request)
    }

    /// Notify the user about multiple pending failures.
    func sendBatchFailure(count: Int) {
        let content = UNMutableNotificationContent()
        content.title = "Receipts Need Attention"
        content.body  = "\(count) receipt\(count == 1 ? "" : "s") failed to upload to Wave. Tap to review."
        content.sound = .default
        content.badge = NSNumber(value: count)

        let request = UNNotificationRequest(
            identifier: "upload-fail-batch",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }

    // MARK: - Health Alerts

    /// Warn the user that their Wave token is no longer valid.
    func sendTokenExpired(service: String) {
        let content = UNMutableNotificationContent()
        content.title = "\(service) Connection Lost"
        content.body  = "Your \(service) token has expired. Open Viewpoint to reconnect."
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: "health-\(service.lowercased())",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }

    // MARK: - Badge

    /// Clear the app badge.
    func clearBadge() {
        UNUserNotificationCenter.current().setBadgeCount(0)
    }
}
