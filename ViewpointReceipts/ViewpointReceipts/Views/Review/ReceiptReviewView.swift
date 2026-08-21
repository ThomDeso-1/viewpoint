import SwiftUI
import SwiftData

/// Presents the extraction results for a receipt, lets the user correct any
/// field, and saves the reviewed data back to the Receipt model and sidecar.
///
/// Shown as a sheet after scanning (auto-extracts) or when tapping a
/// `captured` / `extracted` receipt from the list.
struct ReceiptReviewView: View {

    @Bindable var receipt: Receipt

    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Environment(StorageService.self) private var storageService

    // Extraction state
    @State private var extractionState: ExtractionState = .idle
    @State private var extractionResult: ExtractionResult?

    // Editable fields (populated from extraction or existing data)
    @State private var receiptDate = Date()
    @State private var vendor = ""
    @State private var summary = ""
    @State private var totalAmount = ""
    @State private var taxAmount = ""
    @State private var currency = "CAD"

    // Validation
    @State private var duplicateWarning: String?
    @State private var validationWarnings: [String] = []

    // UI state
    @State private var showingSaveError = false
    @State private var saveError: String?

    private enum ExtractionState: Equatable {
        case idle
        case extracting
        case extracted
        case failed(String)
        case noApiKey
    }

    var body: some View {
        NavigationStack {
            Group {
                switch extractionState {
                case .idle, .extracting:
                    extractingView
                case .extracted:
                    reviewForm
                case .failed(let message):
                    errorView(message: message)
                case .noApiKey:
                    noApiKeyView
                }
            }
            .navigationTitle("Review Receipt")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .alert("Save Error", isPresented: $showingSaveError) {
                Button("OK") { saveError = nil }
            } message: {
                Text(saveError ?? "An unexpected error occurred.")
            }
        }
        .interactiveDismissDisabled(extractionState == .extracting)
        .task {
            await runExtractionIfNeeded()
        }
    }

    // MARK: - Extracting View

    private var extractingView: some View {
        VStack(spacing: 24) {
            Spacer()

            receiptPreview
                .frame(height: 200)

            ProgressView()
                .scaleEffect(1.3)

            Text("Extracting receipt data…")
                .font(.headline)
                .foregroundStyle(.secondary)

            Text("This usually takes a few seconds.")
                .font(.caption)
                .foregroundStyle(.tertiary)

            Spacer()
        }
        .padding()
    }

    // MARK: - Error View

    private func errorView(message: String) -> some View {
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 48))
                .foregroundStyle(.orange)

            Text("Extraction Failed")
                .font(.title2.bold())

            Text(message)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            HStack(spacing: 16) {
                Button("Enter Manually") {
                    populateDefaults()
                    extractionState = .extracted
                }
                .buttonStyle(.bordered)

                Button("Retry") {
                    Task { await runExtraction() }
                }
                .buttonStyle(.borderedProminent)
            }

            Spacer()
        }
        .padding()
    }

    // MARK: - No API Key View

    private var noApiKeyView: some View {
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "key.slash")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)

            Text("No Claude API Key")
                .font(.title2.bold())

            Text("Add your Claude API key in Settings to enable automatic extraction, or enter the receipt data manually.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            Button("Enter Manually") {
                populateDefaults()
                extractionState = .extracted
            }
            .buttonStyle(.borderedProminent)

            Spacer()
        }
        .padding()
    }

    // MARK: - Review Form

    private var reviewForm: some View {
        ScrollView {
            VStack(spacing: 24) {
                receiptPreview
                    .frame(height: 220)

                if let result = extractionResult {
                    confidenceBanner(result.confidence)

                    if !result.isReconciled {
                        reconciliationWarning
                    }
                }

                if let warning = duplicateWarning {
                    warningBanner(
                        icon: "doc.on.doc.fill",
                        message: warning,
                        color: .orange
                    )
                }

                ForEach(validationWarnings, id: \.self) { warning in
                    warningBanner(
                        icon: "exclamationmark.circle.fill",
                        message: warning,
                        color: .yellow
                    )
                }

                editableFields

                approveButton
            }
            .padding(.bottom, 32)
        }
    }

    // MARK: - Receipt Preview

    @ViewBuilder
    private var receiptPreview: some View {
        if let image = storageService.loadImage(forPath: receipt.primaryImagePath) {
            Image(uiImage: image)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .shadow(radius: 4)
                .padding(.horizontal)
        }
    }

    // MARK: - Confidence Banner

    private func confidenceBanner(_ confidence: String) -> some View {
        let (icon, color, text): (String, Color, String) = {
            switch confidence.lowercased() {
            case "high":
                return ("checkmark.seal.fill", .green, "High confidence — fields look good")
            case "medium":
                return ("exclamationmark.circle.fill", .orange, "Medium confidence — please double-check the fields")
            default:
                return ("exclamationmark.triangle.fill", .red, "Low confidence — image was hard to read")
            }
        }()

        return HStack(spacing: 8) {
            Image(systemName: icon)
            Text(text)
                .font(.caption.weight(.medium))
        }
        .foregroundStyle(color)
        .padding(.vertical, 8)
        .padding(.horizontal, 12)
        .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal)
    }

    private var reconciliationWarning: some View {
        warningBanner(
            icon: "exclamationmark.triangle.fill",
            message: "Subtotal + tax doesn't match total — check the amounts",
            color: .orange
        )
    }

    private func warningBanner(icon: String, message: String, color: Color) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
            Text(message)
                .font(.caption.weight(.medium))
        }
        .foregroundStyle(color)
        .padding(.vertical, 8)
        .padding(.horizontal, 12)
        .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal)
    }

    // MARK: - Editable Fields

    private var editableFields: some View {
        VStack(spacing: 0) {
            fieldRow("Date") {
                DatePicker("", selection: $receiptDate, displayedComponents: .date)
                    .labelsHidden()
            }
            Divider().padding(.leading)

            fieldRow("Vendor") {
                TextField("Business name", text: $vendor)
                    .multilineTextAlignment(.trailing)
            }
            Divider().padding(.leading)

            fieldRow("Description") {
                TextField("What was purchased", text: $summary)
                    .multilineTextAlignment(.trailing)
            }
            Divider().padding(.leading)

            fieldRow("Total") {
                HStack(spacing: 4) {
                    Text("$")
                        .foregroundStyle(.secondary)
                    TextField("0.00", text: $totalAmount)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                }
            }
            Divider().padding(.leading)

            fieldRow("Tax") {
                HStack(spacing: 4) {
                    Text("$")
                        .foregroundStyle(.secondary)
                    TextField("0.00", text: $taxAmount)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                }
            }
            Divider().padding(.leading)

            fieldRow("Currency") {
                TextField("CAD", text: $currency)
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.characters)
            }
        }
        .padding(.horizontal)
    }

    private func fieldRow<Content: View>(
        _ label: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        HStack {
            Text(label)
                .foregroundStyle(.secondary)
            Spacer()
            content()
        }
        .font(.subheadline)
        .padding(.vertical, 10)
    }

    // MARK: - Approve Button

    private var approveButton: some View {
        Button {
            approveReceipt()
        } label: {
            Label("Approve", systemImage: "checkmark.circle.fill")
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
        }
        .buttonStyle(.borderedProminent)
        .tint(.green)
        .padding(.horizontal, 20)
    }

    // MARK: - Extraction Logic

    private func runExtractionIfNeeded() async {
        // If the receipt already has extracted data, populate from it
        if receipt.status == .extracted || receipt.status == .reviewed {
            populateFromReceipt()
            extractionState = .extracted
            return
        }

        // Check for API key
        guard KeychainService.shared.retrieve(forKey: KeychainService.Keys.claudeApiKey) != nil else {
            extractionState = .noApiKey
            return
        }

        await runExtraction()
    }

    private func runExtraction() async {
        guard let apiKey = KeychainService.shared.retrieve(
            forKey: KeychainService.Keys.claudeApiKey
        ) else {
            extractionState = .noApiKey
            return
        }

        extractionState = .extracting

        // Load all page images
        let images = receipt.allImagePaths.compactMap { path in
            storageService.loadImage(forPath: path)
        }
        guard !images.isEmpty else {
            extractionState = .failed("Could not load receipt images from storage.")
            return
        }

        do {
            let (result, rawJSON) = try await ClaudeAPIService.shared.extractReceipt(
                images: images,
                apiKey: apiKey
            )
            extractionResult = result
            populateFromExtraction(result)

            // Update the receipt model
            receipt.vendor = result.vendor
            receipt.summary = result.summaryDescription
            receipt.totalAmount = result.total
            receipt.taxAmount = result.totalTax
            receipt.currency = result.currency
            receipt.extractedJSON = rawJSON
            receipt.receiptDate = result.parsedDate
            receipt.status = .extracted

            // Save sidecar
            saveSidecar(extraction: result)

            try? modelContext.save()

            extractionState = .extracted
        } catch {
            extractionState = .failed(error.localizedDescription)
        }
    }

    // MARK: - Population Helpers

    private func populateFromExtraction(_ result: ExtractionResult) {
        receiptDate = result.parsedDate
        vendor = result.vendor
        summary = result.summaryDescription
        totalAmount = String(format: "%.2f", result.total)
        taxAmount = String(format: "%.2f", result.totalTax)
        currency = result.currency
        checkForDuplicates()
        runValidationChecks()
    }

    private func populateFromReceipt() {
        receiptDate = receipt.receiptDate
        vendor = receipt.vendor ?? ""
        summary = receipt.summary ?? ""
        totalAmount = receipt.totalAmount.map { String(format: "%.2f", $0) } ?? ""
        taxAmount = receipt.taxAmount.map { String(format: "%.2f", $0) } ?? ""
        currency = receipt.currency ?? "CAD"
        checkForDuplicates()
        runValidationChecks()
    }

    private func populateDefaults() {
        receiptDate = receipt.receiptDate
        vendor = ""
        summary = ""
        totalAmount = ""
        taxAmount = ""
        currency = "CAD"
    }

    // MARK: - Approve

    private func approveReceipt() {
        let originalDate = receipt.receiptDate

        // Update receipt from form fields
        receipt.receiptDate = receiptDate
        receipt.vendor = vendor.isEmpty ? nil : vendor
        receipt.summary = summary.isEmpty ? nil : summary
        receipt.totalAmount = Double(totalAmount)
        receipt.taxAmount = Double(taxAmount)
        receipt.currency = currency.isEmpty ? "CAD" : currency
        receipt.status = .reviewed

        // Re-file images if the date changed months
        let originalMonth = storageService.monthFolderName(for: originalDate)
        let newMonth = storageService.monthFolderName(for: receiptDate)

        if originalMonth != newMonth {
            do {
                let newPrimary = try storageService.moveReceiptImage(
                    from: receipt.primaryImagePath, toDate: receiptDate
                )
                // Move the sidecar too
                storageService.moveSidecar(
                    fromImagePath: receipt.primaryImagePath,
                    toImagePath: newPrimary
                )
                receipt.primaryImagePath = newPrimary

                var newAdditional: [String] = []
                for path in receipt.additionalImagePaths {
                    let moved = try storageService.moveReceiptImage(from: path, toDate: receiptDate)
                    newAdditional.append(moved)
                }
                receipt.additionalImagePaths = newAdditional
                receipt.monthFolder = newMonth
            } catch {
                saveError = "Saved data but could not move files to \(newMonth): \(error.localizedDescription)"
                showingSaveError = true
            }
        }

        // Update sidecar with reviewed data
        let reviewed = ReviewedData(
            receiptDate: receiptDate,
            vendor: vendor,
            summaryDescription: summary,
            subtotal: Double(totalAmount) ?? 0 - (Double(taxAmount) ?? 0),
            taxAmount: Double(taxAmount) ?? 0,
            total: Double(totalAmount) ?? 0,
            currency: currency.isEmpty ? "CAD" : currency
        )
        updateSidecar(reviewed: reviewed)

        try? modelContext.save()
        dismiss()
    }

    // MARK: - Duplicate Detection

    private func checkForDuplicates() {
        duplicateWarning = nil

        // Check by image hash (filter in memory — #Predicate can't compare optionals reliably)
        if let hash = receipt.imageHash, !hash.isEmpty {
            let descriptor = FetchDescriptor<Receipt>()
            if let all = try? modelContext.fetch(descriptor) {
                let matches = all.filter { $0.id != receipt.id && $0.imageHash == hash }
                if let first = matches.first {
                    duplicateWarning = "This image matches an existing receipt (\(first.vendor ?? "unknown vendor"))."
                    return
                }
            }
        }

        // Check by date + vendor + total
        guard let total = Double(totalAmount), !vendor.isEmpty else { return }
        let vendorName = vendor
        let date = receiptDate

        // Fetch all receipts and filter in memory (SwiftData predicate limitations with optionals)
        let descriptor = FetchDescriptor<Receipt>()
        guard let all = try? modelContext.fetch(descriptor) else { return }

        let calendar = Calendar.current
        let duplicate = all.first { r in
            r.id != receipt.id
            && r.vendor == vendorName
            && r.totalAmount == total
            && calendar.isDate(r.receiptDate, inSameDayAs: date)
        }

        if let dup = duplicate {
            duplicateWarning = "A receipt from \(dup.vendor ?? vendorName) for the same amount on the same date already exists."
        }
    }

    // MARK: - Validation Checks

    private func runValidationChecks() {
        var warnings: [String] = []

        // Future date
        if receiptDate > Date() {
            warnings.append("Receipt date is in the future.")
        }

        // Very old receipt (>1 year)
        if let oneYearAgo = Calendar.current.date(byAdding: .year, value: -1, to: Date()),
           receiptDate < oneYearAgo {
            warnings.append("Receipt date is more than a year old.")
        }

        // Non-CAD currency
        let cur = currency.trimmingCharacters(in: .whitespaces).uppercased()
        if !cur.isEmpty && cur != "CAD" {
            warnings.append("Currency is \(cur), not CAD — confirm this is correct.")
        }

        // Zero or negative total
        if let total = Double(totalAmount), total <= 0 {
            warnings.append("Total is zero or negative.")
        }

        validationWarnings = warnings
    }

    // MARK: - Sidecar Helpers

    private func saveSidecar(extraction: ExtractionResult) {
        var sidecar = storageService.loadSidecar(forImagePath: receipt.primaryImagePath)
            ?? ReceiptSidecar(capturedAt: receipt.captureDate)
        sidecar.extraction = extraction
        sidecar.status = "extracted"
        sidecar.extractedAt = Date()
        storageService.saveSidecar(sidecar, forImagePath: receipt.primaryImagePath)
    }

    private func updateSidecar(reviewed: ReviewedData) {
        var sidecar = storageService.loadSidecar(forImagePath: receipt.primaryImagePath)
            ?? ReceiptSidecar(capturedAt: receipt.captureDate)
        sidecar.reviewed = reviewed
        sidecar.status = "reviewed"
        sidecar.reviewedAt = Date()
        storageService.saveSidecar(sidecar, forImagePath: receipt.primaryImagePath)
    }
}

// MARK: - ReviewedData convenience init

extension ReviewedData {
    init(
        receiptDate: Date,
        vendor: String,
        summaryDescription: String,
        subtotal: Double,
        taxAmount: Double,
        total: Double,
        currency: String
    ) {
        self.receiptDate = receiptDate
        self.vendor = vendor
        self.summaryDescription = summaryDescription
        self.subtotal = subtotal
        self.taxAmount = taxAmount
        self.total = total
        self.currency = currency
    }
}
