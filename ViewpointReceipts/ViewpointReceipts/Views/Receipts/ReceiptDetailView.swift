import SwiftUI

/// Full-screen view of a single receipt with its image and metadata.
struct ReceiptDetailView: View {

    let receipt: Receipt

    @Environment(StorageService.self) private var storageService
    @Environment(UploadService.self) private var uploadService
    @Environment(\.modelContext) private var modelContext
    @State private var currentPage = 0

    private var allPaths: [String] {
        receipt.allImagePaths
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                imageViewer
                infoSection

                // Retry button for failed/needs-attention receipts
                if receipt.status == .failed || receipt.status == .needsAttention {
                    Button {
                        uploadService.retryReceipt(receipt, modelContext: modelContext)
                    } label: {
                        Label("Retry Upload", systemImage: "arrow.clockwise")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                    }
                    .buttonStyle(.borderedProminent)
                    .padding(.horizontal)
                }
            }
            .padding(.bottom, 32)
        }
        .navigationTitle("Receipt")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Image Viewer

    @ViewBuilder
    private var imageViewer: some View {
        TabView(selection: $currentPage) {
            ForEach(Array(allPaths.enumerated()), id: \.offset) { index, path in
                receiptImage(for: path)
                    .tag(index)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: allPaths.count > 1 ? .always : .never))
        .frame(height: UIScreen.main.bounds.height * 0.55)
        .background(Color(.systemGroupedBackground))
    }

    @ViewBuilder
    private func receiptImage(for path: String) -> some View {
        if let image = storageService.loadImage(forPath: path) {
            Image(uiImage: image)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .padding(8)
        } else {
            ContentUnavailableView(
                "Image Not Found",
                systemImage: "photo.badge.exclamationmark",
                description: Text("The receipt image may have been moved or deleted.")
            )
        }
    }

    // MARK: - Info Section

    private var infoSection: some View {
        VStack(spacing: 0) {
            InfoRow(label: "Date",
                    value: receipt.receiptDate.formatted(.dateTime.month(.wide).day().year()))
            Divider().padding(.leading)

            InfoRow(label: "Status", value: receipt.status.displayName)
            Divider().padding(.leading)

            if let vendor = receipt.vendor, !vendor.isEmpty {
                InfoRow(label: "Vendor", value: vendor)
                Divider().padding(.leading)
            }

            if let total = receipt.totalAmount {
                InfoRow(label: "Total",
                        value: total.formatted(.currency(code: receipt.currency ?? "CAD")))
                Divider().padding(.leading)
            }

            if let tax = receipt.taxAmount {
                InfoRow(label: "Tax",
                        value: tax.formatted(.currency(code: receipt.currency ?? "CAD")))
                Divider().padding(.leading)
            }

            if allPaths.count > 1 {
                InfoRow(label: "Pages", value: "\(allPaths.count)")
                Divider().padding(.leading)
            }

            InfoRow(label: "Captured",
                    value: receipt.captureDate.formatted(.dateTime.month(.abbreviated).day().hour().minute()))

            // Wave transaction info
            if let txnId = receipt.waveTransactionId, !txnId.isEmpty {
                Divider().padding(.leading)
                InfoRow(label: "Wave ID", value: String(txnId.suffix(12)))
            }

            if let error = receipt.lastError, !error.isEmpty {
                Divider().padding(.leading)
                InfoRow(label: "Last Error", value: error, isError: true)
            }

            if receipt.retryCount > 0 && receipt.status != .uploaded {
                Divider().padding(.leading)
                InfoRow(label: "Retries", value: "\(receipt.retryCount)")
            }
        }
        .padding(.horizontal)
    }
}

// MARK: - Info Row

private struct InfoRow: View {

    let label: String
    let value: String
    var isError: Bool = false

    var body: some View {
        HStack {
            Text(label)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .foregroundStyle(isError ? .red : .primary)
                .multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
        .padding(.vertical, 10)
    }
}
