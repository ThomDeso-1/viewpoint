import SwiftUI
import SwiftData
import ImageIO

// MARK: - Receipt List

struct ReceiptListView: View {

    @Environment(\.modelContext) private var modelContext
    @Environment(StorageService.self) private var storageService
    @Environment(AppSettings.self) private var settings
    @Environment(UploadService.self) private var uploadService
    @Environment(HealthCheckService.self) private var healthCheck
    @Environment(\.scenePhase) private var scenePhase

    @Query(sort: [SortDescriptor(\Receipt.receiptDate, order: .reverse)])
    private var receipts: [Receipt]

    @State private var showingScanner = false
    @State private var showingSettings = false
    @State private var errorMessage: String?
    @State private var showingError = false
    @State private var receiptToReview: Receipt?
    @State private var searchText = ""

    /// Receipts filtered by search text, then grouped by month folder, newest first.
    private var filteredReceipts: [Receipt] {
        guard !searchText.isEmpty else { return receipts.map { $0 } }
        let query = searchText.lowercased()
        return receipts.filter { receipt in
            (receipt.vendor?.lowercased().contains(query) ?? false)
            || (receipt.summary?.lowercased().contains(query) ?? false)
            || receipt.status.displayName.lowercased().contains(query)
            || (receipt.totalAmount.map { String(format: "%.2f", $0).contains(query) } ?? false)
        }
    }

    private var groupedByMonth: [(month: String, receipts: [Receipt])] {
        let grouped = Dictionary(grouping: filteredReceipts) { $0.monthFolder }
        return grouped
            .map { (month: $0.key, receipts: $0.value.sorted { $0.receiptDate > $1.receiptDate }) }
            .sorted { $0.month > $1.month }
    }

    var body: some View {
        NavigationStack {
            Group {
                if receipts.isEmpty {
                    ContentUnavailableView(
                        "No Receipts Yet",
                        systemImage: "doc.viewfinder",
                        description: Text("Tap the camera to scan your first receipt.")
                    )
                } else {
                    receiptList
                }
            }
            .navigationTitle("Receipts")
            .searchable(text: $searchText, prompt: "Vendor, description, or amount")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button {
                        showingSettings = true
                    } label: {
                        Label("Settings", systemImage: "gearshape")
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showingScanner = true
                    } label: {
                        Label("Scan Receipt", systemImage: "camera.viewfinder")
                    }
                }
            }
            .safeAreaInset(edge: .top) {
                if let banner = healthCheck.bannerMessage {
                    healthBanner(banner)
                }
            }
            .safeAreaInset(edge: .bottom) {
                if settings.hasWaveToken {
                    uploadStatusBar
                }
            }
            .navigationDestination(for: Receipt.self) { receipt in
                ReceiptDetailView(receipt: receipt)
            }
            .fullScreenCover(isPresented: $showingScanner) {
                DocumentScannerView(
                    onScan: { images in
                        saveScannedReceipt(images: images)
                        showingScanner = false
                    },
                    onCancel: {
                        showingScanner = false
                    },
                    onError: { error in
                        errorMessage = error.localizedDescription
                        showingError = true
                        showingScanner = false
                    }
                )
                .ignoresSafeArea()
            }
            .sheet(item: $receiptToReview) { receipt in
                ReceiptReviewView(receipt: receipt)
            }
            .sheet(isPresented: $showingSettings) {
                SettingsView()
            }
            .alert("Error", isPresented: $showingError) {
                Button("OK") { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "An unexpected error occurred.")
            }
            .task {
                // Kick off upload queue and refresh counts when the list appears
                if settings.hasWaveToken {
                    uploadService.processQueue(modelContext: modelContext)
                    await uploadService.updateCounts(modelContext: modelContext)
                }
                await healthCheck.runChecks()
            }
            .onChange(of: scenePhase) { _, newPhase in
                if newPhase == .active {
                    Task {
                        await healthCheck.runChecks()
                        if settings.hasWaveToken {
                            uploadService.processQueue(modelContext: modelContext)
                            await uploadService.updateCounts(modelContext: modelContext)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Health Banner

    private func healthBanner(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Text(message)
                .font(.caption)
                .foregroundStyle(.primary)
            Spacer()
            Button {
                healthCheck.dismissBanner()
            } label: {
                Image(systemName: "xmark")
                    .font(.caption2.bold())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial)
    }

    // MARK: - Upload Status Bar

    private var uploadStatusBar: some View {
        HStack(spacing: 16) {
            if uploadService.isProcessing {
                ProgressView()
                    .controlSize(.small)
                Text("Uploading…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if uploadService.failedCount > 0 {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
                    .font(.caption)
                Text("\(uploadService.failedCount) failed")
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            Spacer()

            if uploadService.uploadedCount > 0 || uploadService.pendingCount > 0 {
                HStack(spacing: 12) {
                    Label("\(uploadService.uploadedCount)", systemImage: "checkmark.circle")
                        .foregroundStyle(.green)
                    if uploadService.pendingCount > 0 {
                        Label("\(uploadService.pendingCount)", systemImage: "clock")
                            .foregroundStyle(.orange)
                    }
                }
                .font(.caption)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial)
    }

    // MARK: - Subviews

    private var receiptList: some View {
        List {
            ForEach(groupedByMonth, id: \.month) { group in
                Section {
                    ForEach(group.receipts) { receipt in
                        NavigationLink(value: receipt) {
                            ReceiptRowView(receipt: receipt)
                        }
                        .swipeActions(edge: .leading) {
                            if receipt.status == .captured || receipt.status == .extracted {
                                Button {
                                    receiptToReview = receipt
                                } label: {
                                    Label("Review", systemImage: "doc.text.magnifyingglass")
                                }
                                .tint(.orange)
                            }
                        }
                        .swipeActions(edge: .trailing) {
                            if receipt.status == .failed || receipt.status == .needsAttention {
                                Button {
                                    uploadService.retryReceipt(receipt, modelContext: modelContext)
                                } label: {
                                    Label("Retry", systemImage: "arrow.clockwise")
                                }
                                .tint(.blue)
                            }
                        }
                    }
                    .onDelete { indexSet in
                        deleteReceipts(in: group.receipts, at: indexSet)
                    }
                } header: {
                    HStack {
                        Text(Self.displayMonth(group.month))
                        Spacer()
                        Text(Self.monthTotal(group.receipts))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    // MARK: - Actions

    private func saveScannedReceipt(images: [UIImage]) {
        let now = Date()
        do {
            let result = try storageService.saveReceiptImages(images, date: now)
            let monthFolder = storageService.monthFolderName(for: now)

            let receipt = Receipt(
                primaryImagePath: result.primaryPath,
                additionalImagePaths: result.additionalPaths,
                receiptDate: now,
                monthFolder: monthFolder
            )
            receipt.imageHash = storageService.computeImageHash(forPath: result.primaryPath)
            modelContext.insert(receipt)
            try modelContext.save()

            // Automatically open the review/extraction sheet
            receiptToReview = receipt
        } catch {
            errorMessage = "Failed to save receipt: \(error.localizedDescription)"
            showingError = true
        }
    }

    private func deleteReceipts(in sectionReceipts: [Receipt], at offsets: IndexSet) {
        for index in offsets {
            let receipt = sectionReceipts[index]
            storageService.deleteReceiptFiles(
                primaryPath: receipt.primaryImagePath,
                additionalPaths: receipt.additionalImagePaths
            )
            storageService.deleteSidecarFiles(
                primaryPath: receipt.primaryImagePath,
                additionalPaths: receipt.additionalImagePaths
            )
            modelContext.delete(receipt)
        }
    }

    // MARK: - Helpers

    /// Sum of all receipt totals for a given group.
    static func monthTotal(_ receipts: [Receipt]) -> String {
        let sum = receipts.compactMap(\.totalAmount).reduce(0, +)
        guard sum > 0 else { return "" }
        return sum.formatted(.currency(code: "CAD"))
    }

    /// Converts "2026-08" → "August 2026".
    static func displayMonth(_ key: String) -> String {
        let parts = key.split(separator: "-")
        guard parts.count == 2,
              let year = Int(parts[0]),
              let month = Int(parts[1]),
              (1...12).contains(month)
        else { return key }

        let formatter = DateFormatter()
        formatter.dateFormat = "MMMM yyyy"
        var comps = DateComponents()
        comps.year = year
        comps.month = month
        comps.day = 1
        guard let date = Calendar.current.date(from: comps) else { return key }
        return formatter.string(from: date)
    }
}

// MARK: - Receipt Row

struct ReceiptRowView: View {

    let receipt: Receipt

    var body: some View {
        HStack(spacing: 12) {
            ReceiptThumbnail(path: receipt.primaryImagePath)

            VStack(alignment: .leading, spacing: 4) {
                Text(receipt.receiptDate, format: .dateTime.month(.wide).day().year())
                    .font(.subheadline.weight(.medium))

                if let vendor = receipt.vendor, !vendor.isEmpty {
                    Text(vendor)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let total = receipt.totalAmount {
                    Text(total, format: .currency(code: receipt.currency ?? "CAD"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if receipt.pageCount > 1 {
                    Text("\(receipt.pageCount) pages")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

            Spacer()

            StatusBadge(status: receipt.status)
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Thumbnail

/// Loads a receipt image thumbnail asynchronously using ImageIO
/// (much faster than decoding the full JPEG).
struct ReceiptThumbnail: View {

    let path: String
    @Environment(StorageService.self) private var storageService
    @State private var thumbnail: UIImage?

    var body: some View {
        Group {
            if let thumbnail {
                Image(uiImage: thumbnail)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else {
                Rectangle()
                    .fill(.quaternary)
                    .overlay {
                        Image(systemName: "photo")
                            .foregroundStyle(.secondary)
                            .font(.caption)
                    }
            }
        }
        .frame(width: 52, height: 52)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .task(id: path) {
            thumbnail = await generateThumbnail()
        }
    }

    private func generateThumbnail() async -> UIImage? {
        let url = storageService.imageURL(forPath: path)
        let options: [CFString: Any] = [
            kCGImageSourceThumbnailMaxPixelSize: 120 as CFNumber,
            kCGImageSourceCreateThumbnailFromImageAlways: true as CFBoolean,
            kCGImageSourceCreateThumbnailWithTransform: true as CFBoolean,
        ]
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        else { return nil }

        return UIImage(cgImage: cgImage)
    }
}

// MARK: - Status Badge

struct StatusBadge: View {

    let status: ReceiptStatus

    var body: some View {
        Text(status.displayName)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(badgeColor.opacity(0.12), in: Capsule())
            .foregroundStyle(badgeColor)
    }

    private var badgeColor: Color {
        switch status {
        case .captured:       return .blue
        case .extracted:      return .orange
        case .reviewed:       return .purple
        case .uploaded:       return .green
        case .needsAttention: return .yellow
        case .failed:         return .red
        }
    }
}
