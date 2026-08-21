import Foundation

// MARK: - Extraction Result

/// Structured data returned by the Claude API vision extraction.
struct ExtractionResult: Codable {

    let receiptDate: String              // "YYYY-MM-DD"
    let vendor: String
    let items: [LineItem]
    let summaryDescription: String
    let subtotal: Double
    let taxes: [TaxEntry]
    let total: Double
    let currency: String                 // "CAD"
    let confidence: String               // "high" | "medium" | "low"

    /// Parsed receipt date, falling back to today if the string is invalid.
    var parsedDate: Date {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter.date(from: receiptDate) ?? Date()
    }

    /// Sum of all tax entries.
    var totalTax: Double {
        taxes.reduce(0) { $0 + $1.amount }
    }

    /// Whether the arithmetic reconciles within one cent.
    var isReconciled: Bool {
        abs((subtotal + totalTax) - total) < 0.02
    }
}

// MARK: - Line Item

struct LineItem: Codable, Identifiable {

    let description: String
    let amount: Double

    var id: String { "\(description)-\(amount)" }
}

// MARK: - Tax Entry

struct TaxEntry: Codable, Identifiable {

    let type: String        // "HST", "GST", "PST"
    let rate: Double        // 0.13
    let amount: Double

    var id: String { "\(type)-\(rate)" }

    /// Human-readable display, e.g. "HST (13%)"
    var displayName: String {
        "\(type) (\(Int(rate * 100))%)"
    }
}

// MARK: - Receipt Sidecar

/// The JSON sidecar file saved alongside each receipt image.
/// Contains the extraction result, any reviewed edits, status, and timestamps.
struct ReceiptSidecar: Codable {

    var extraction: ExtractionResult?
    var reviewed: ReviewedData?
    var status: String                   // mirrors ReceiptStatus.rawValue
    var capturedAt: Date
    var extractedAt: Date?
    var reviewedAt: Date?
    var uploadedAt: Date?
    var waveTransactionId: String?

    init(
        extraction: ExtractionResult? = nil,
        reviewed: ReviewedData? = nil,
        status: String = "captured",
        capturedAt: Date = Date()
    ) {
        self.extraction = extraction
        self.status = status
        self.capturedAt = capturedAt
    }
}

// MARK: - Reviewed Data

/// The user's confirmed (possibly corrected) version of the extraction.
struct ReviewedData: Codable {

    var receiptDate: Date
    var vendor: String
    var summaryDescription: String
    var subtotal: Double
    var taxAmount: Double
    var total: Double
    var currency: String

    /// Create from an extraction result with no edits.
    init(from extraction: ExtractionResult) {
        self.receiptDate = extraction.parsedDate
        self.vendor = extraction.vendor
        self.summaryDescription = extraction.summaryDescription
        self.subtotal = extraction.subtotal
        self.taxAmount = extraction.totalTax
        self.total = extraction.total
        self.currency = extraction.currency
    }
}
