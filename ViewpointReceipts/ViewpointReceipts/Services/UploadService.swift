import Foundation
import SwiftData
import Observation

// MARK: - Upload Service

/// Manages the queue of reviewed receipts waiting to be uploaded to Wave.
///
/// Processes receipts with exponential backoff on failure, tracks upload
/// status, and triggers notifications when retries are exhausted.
@Observable
final class UploadService {

    // MARK: - Configuration

    private let maxRetries = 5
    private let baseDelay: TimeInterval = 5       // seconds
    private let maxDelay: TimeInterval  = 300     // 5 minutes

    // MARK: - State

    var isProcessing = false
    var lastError: String?

    /// Summary counts for the status line.
    var uploadedCount  = 0
    var pendingCount   = 0
    var failedCount    = 0

    private let settings: AppSettings
    private var processingTask: Task<Void, Never>?

    init(settings: AppSettings) {
        self.settings = settings
    }

    // MARK: - Queue Processing

    /// Process all reviewed receipts that haven't been uploaded yet.
    /// Call this after the app launches and after each review approval.
    func processQueue(modelContext: ModelContext) {
        guard !isProcessing else { return }
        guard settings.hasWaveToken else { return }

        processingTask?.cancel()
        processingTask = Task { [weak self] in
            await self?.runQueue(modelContext: modelContext)
        }
    }

    /// Stop any in-progress processing.
    func stopProcessing() {
        processingTask?.cancel()
        processingTask = nil
        isProcessing = false
    }

    private func runQueue(modelContext: ModelContext) async {
        isProcessing = true
        defer { isProcessing = false }

        guard let token = KeychainService.shared.retrieve(
            forKey: KeychainService.Keys.waveAccessToken
        ) else {
            lastError = "No Wave access token found."
            return
        }

        let businessId    = settings.waveBusinessId
        let expenseAcctId = settings.waveExpenseAccountId
        let anchorAcctId  = settings.waveAnchorAccountId
        let salesTaxId    = settings.waveSalesTaxId

        guard !businessId.isEmpty, !expenseAcctId.isEmpty, !anchorAcctId.isEmpty else {
            lastError = "Wave is not fully configured. Complete setup in Settings."
            return
        }

        // Fetch all reviewed receipts
        let descriptor = FetchDescriptor<Receipt>(
            predicate: #Predicate<Receipt> { $0.statusRaw == "reviewed" },
            sortBy: [SortDescriptor(\Receipt.receiptDate)]
        )
        guard let receipts = try? modelContext.fetch(descriptor) else { return }

        for receipt in receipts {
            guard !Task.isCancelled else { break }

            let dateString = Self.dateString(from: receipt.receiptDate)
            let description = Self.transactionDescription(for: receipt)
            let amount = receipt.totalAmount ?? 0

            guard amount > 0 else {
                receipt.status = .needsAttention
                receipt.lastError = "Total amount is zero or missing."
                try? modelContext.save()
                continue
            }

            do {
                let result = try await WaveAPIService.shared.createExpenseTransaction(
                    businessId: businessId,
                    date: dateString,
                    description: description,
                    amount: amount,
                    expenseAccountId: expenseAcctId,
                    anchorAccountId: anchorAcctId,
                    salesTaxId: salesTaxId.isEmpty ? nil : salesTaxId,
                    token: token
                )

                if result.didSucceed, let txnId = result.transactionId {
                    receipt.waveTransactionId = txnId
                    receipt.status = .uploaded
                    receipt.lastError = nil
                    receipt.retryCount = 0
                } else {
                    let reason = result.errors.joined(separator: "; ")
                    receipt.lastError = reason
                    receipt.status = .needsAttention
                }
                try? modelContext.save()

            } catch let error as WaveAPIError where error.isRetryable {
                receipt.retryCount += 1
                receipt.lastError = error.localizedDescription

                if receipt.retryCount >= maxRetries {
                    receipt.status = .failed
                    NotificationService.shared.sendUploadFailure(
                        receiptDescription: description,
                        error: error.localizedDescription
                    )
                }
                try? modelContext.save()

                // Exponential backoff before next attempt
                let delay = min(
                    baseDelay * pow(2.0, Double(receipt.retryCount - 1)),
                    maxDelay
                )
                try? await Task.sleep(for: .seconds(delay))

            } catch {
                receipt.retryCount += 1
                receipt.lastError = error.localizedDescription
                receipt.status = .needsAttention

                if receipt.retryCount >= maxRetries {
                    receipt.status = .failed
                    NotificationService.shared.sendUploadFailure(
                        receiptDescription: description,
                        error: error.localizedDescription
                    )
                }
                try? modelContext.save()
            }
        }

        // Refresh summary counts
        await updateCounts(modelContext: modelContext)
    }

    // MARK: - Retry

    /// Retry a single failed receipt.
    func retryReceipt(_ receipt: Receipt, modelContext: ModelContext) {
        receipt.retryCount = 0
        receipt.status = .reviewed
        receipt.lastError = nil
        try? modelContext.save()
        processQueue(modelContext: modelContext)
    }

    /// Retry all failed/needs-attention receipts.
    func retryAll(modelContext: ModelContext) {
        let descriptor = FetchDescriptor<Receipt>(
            predicate: #Predicate<Receipt> {
                $0.statusRaw == "failed" || $0.statusRaw == "needsAttention"
            }
        )
        guard let receipts = try? modelContext.fetch(descriptor) else { return }
        for receipt in receipts {
            receipt.retryCount = 0
            receipt.status = .reviewed
            receipt.lastError = nil
        }
        try? modelContext.save()
        processQueue(modelContext: modelContext)
    }

    // MARK: - Counts

    func updateCounts(modelContext: ModelContext) async {
        let uploaded = FetchDescriptor<Receipt>(
            predicate: #Predicate<Receipt> { $0.statusRaw == "uploaded" }
        )
        let pending = FetchDescriptor<Receipt>(
            predicate: #Predicate<Receipt> {
                $0.statusRaw == "reviewed" || $0.statusRaw == "extracted"
            }
        )
        let failed = FetchDescriptor<Receipt>(
            predicate: #Predicate<Receipt> {
                $0.statusRaw == "failed" || $0.statusRaw == "needsAttention"
            }
        )

        uploadedCount = (try? modelContext.fetchCount(uploaded)) ?? 0
        pendingCount  = (try? modelContext.fetchCount(pending))  ?? 0
        failedCount   = (try? modelContext.fetchCount(failed))   ?? 0
    }

    // MARK: - Helpers

    private static let isoDateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    static func dateString(from date: Date) -> String {
        isoDateFormatter.string(from: date)
    }

    /// Build the description that goes into Wave's transaction.
    static func transactionDescription(for receipt: Receipt) -> String {
        var parts: [String] = []
        if let vendor = receipt.vendor, !vendor.isEmpty {
            parts.append(vendor)
        }
        if let summary = receipt.summary, !summary.isEmpty {
            parts.append(summary)
        }
        return parts.isEmpty ? "Expense" : parts.joined(separator: " — ")
    }
}
