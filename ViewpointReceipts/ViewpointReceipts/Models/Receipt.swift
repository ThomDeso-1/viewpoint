import Foundation
import SwiftData

// MARK: - Receipt Status

enum ReceiptStatus: String, Codable, CaseIterable {
    case captured           // Phase 1: image saved, no extraction yet
    case extracted          // Phase 2: Claude API returned structured data
    case reviewed           // Phase 2: user confirmed/corrected the extraction
    case uploaded           // Phase 3: transaction created in Wave
    case needsAttention     // any phase: requires user action
    case failed             // any phase: unrecoverable error

    var displayName: String {
        switch self {
        case .captured:       return "Captured"
        case .extracted:      return "Extracted"
        case .reviewed:       return "Reviewed"
        case .uploaded:       return "Uploaded"
        case .needsAttention: return "Attention"
        case .failed:         return "Failed"
        }
    }
}

// MARK: - Receipt Model

@Model
final class Receipt {

    // Identity
    var id: UUID

    // Images — paths relative to the receipts root folder
    var primaryImagePath: String
    var additionalImagePaths: [String]

    // Dates
    var receiptDate: Date          // used for monthly foldering (capture date in P1, extracted in P2)
    var captureDate: Date          // when the photo was actually taken

    // Filing
    var monthFolder: String        // "2026-08" — denormalized for fast grouping

    // Status
    var statusRaw: String

    // Phase 2 — extraction fields (nil until extracted)
    var vendor: String?
    var summary: String?
    var totalAmount: Double?
    var taxAmount: Double?
    var currency: String?
    var extractedJSON: String?     // full Claude response for reference

    // Phase 3 — Wave upload fields
    var waveTransactionId: String?
    var lastError: String?
    var retryCount: Int

    // Metadata
    var imageHash: String?
    var createdAt: Date
    var updatedAt: Date

    // MARK: Computed

    var status: ReceiptStatus {
        get { ReceiptStatus(rawValue: statusRaw) ?? .captured }
        set {
            statusRaw = newValue.rawValue
            updatedAt = Date()
        }
    }

    var pageCount: Int {
        1 + additionalImagePaths.count
    }

    var allImagePaths: [String] {
        [primaryImagePath] + additionalImagePaths
    }

    // MARK: Init

    init(
        primaryImagePath: String,
        additionalImagePaths: [String] = [],
        receiptDate: Date,
        monthFolder: String
    ) {
        self.id = UUID()
        self.primaryImagePath = primaryImagePath
        self.additionalImagePaths = additionalImagePaths
        self.receiptDate = receiptDate
        self.captureDate = Date()
        self.monthFolder = monthFolder
        self.statusRaw = ReceiptStatus.captured.rawValue
        self.retryCount = 0
        self.createdAt = Date()
        self.updatedAt = Date()
    }
}
