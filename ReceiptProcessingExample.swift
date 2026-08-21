import SwiftUI

/// Example integration showing how to use the receipt capture functionality
struct ReceiptProcessingExample: View {
    @State private var receiptImage: UIImage?
    @State private var showingCapture = false
    @State private var isProcessing = false
    @State private var extractedText: String?
    @State private var receiptData: ReceiptData?
    
    // Image editing states
    @State private var tempImage: UIImage?
    @State private var showingCropper = false
    @State private var showingEnhancer = false
    @State private var processingStep: ProcessingStep = .capture
    
    enum ProcessingStep {
        case capture
        case crop
        case enhance
        case process
        case complete
    }
    
    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                if let image = receiptImage {
                    // Display the captured/uploaded image
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxHeight: 300)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .shadow(radius: 5)
                        .padding()
                    
                    // Edit options (if not already processed)
                    if processingStep != .complete && !isProcessing {
                        HStack(spacing: 12) {
                            Button {
                                tempImage = image
                                showingCropper = true
                            } label: {
                                Label("Crop", systemImage: "crop")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            
                            Button {
                                tempImage = image
                                showingEnhancer = true
                            } label: {
                                Label("Enhance", systemImage: "wand.and.stars")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                        }
                        .padding(.horizontal)
                    }
                    
                    if isProcessing {
                        ProgressView("Processing receipt...")
                            .padding()
                    } else if let data = receiptData {
                        ReceiptDataView(data: data)
                            .padding()
                    } else if let text = extractedText {
                        VStack(alignment: .leading) {
                            Text("Extracted Information:")
                                .font(.headline)
                            ScrollView {
                                Text(text)
                                    .font(.caption)
                                    .padding()
                                    .background(Color.gray.opacity(0.1))
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                            }
                        }
                        .padding()
                    }
                    
                    Button("Process Another Receipt") {
                        resetState()
                        showingCapture = true
                    }
                    .buttonStyle(.borderedProminent)
                    
                } else {
                    ContentUnavailableView {
                        Label("No Receipt", systemImage: "receipt")
                    } description: {
                        Text("Add a receipt image to get started")
                    } actions: {
                        Button("Add Receipt") {
                            showingCapture = true
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
            }
            .navigationTitle("Receipt Scanner")
            .sheet(isPresented: $showingCapture) {
                ReceiptCaptureView(capturedImage: $receiptImage)
            }
            .sheet(isPresented: $showingCropper) {
                if let image = tempImage {
                    AdvancedImageCropper(image: $receiptImage, originalImage: image)
                }
            }
            .sheet(isPresented: $showingEnhancer) {
                if let image = tempImage {
                    ImageEnhancementView(image: $receiptImage, originalImage: image)
                }
            }
            .onChange(of: receiptImage) { oldValue, newImage in
                if newImage != nil && oldValue == nil {
                    // New image captured/uploaded - offer to crop/enhance
                    processingStep = .crop
                } else if newImage != nil && oldValue != nil {
                    // Image was edited - auto-process after a short delay
                    Task {
                        try? await Task.sleep(for: .milliseconds(500))
                        if let image = newImage {
                            processReceipt(image)
                        }
                    }
                }
            }
        }
    }
    
    private func resetState() {
        receiptImage = nil
        extractedText = nil
        receiptData = nil
        tempImage = nil
        processingStep = .capture
    }
    
    /// Process the receipt image - connect to your existing processing logic
    private func processReceipt(_ image: UIImage) {
        processingStep = .process
        isProcessing = true
        
        Task {
            do {
                // First, auto-enhance the image if not already enhanced
                let enhancedImage = await Task.detached {
                    ImageEnhancementService.shared.enhanceReceipt(image)
                }.value
                
                // Update the image with enhanced version
                await MainActor.run {
                    receiptImage = enhancedImage
                }
                
                // Perform OCR using Vision framework
                let data = try await ReceiptOCRService.shared.extractReceiptData(from: enhancedImage)
                
                // TODO: Add your custom processing here:
                // - Save to database
                // - Upload to server
                // - Categorize expenses
                // - Export to accounting software
                
                await MainActor.run {
                    receiptData = data
                    extractedText = data.rawText
                    isProcessing = false
                    processingStep = .complete
                }
            } catch {
                // Handle OCR errors
                await MainActor.run {
                    extractedText = "Error processing receipt: \(error.localizedDescription)"
                    isProcessing = false
                    processingStep = .complete
                }
            }
        }
    }
}

// MARK: - Receipt Data Display View

struct ReceiptDataView: View {
    let data: ReceiptData
    
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            // Header
            VStack(alignment: .leading, spacing: 4) {
                Text("Receipt Details")
                    .font(.title2)
                    .fontWeight(.bold)
                
                if let storeName = data.storeName {
                    Text(storeName)
                        .font(.headline)
                        .foregroundStyle(.secondary)
                }
                
                Text(data.formattedDate)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            
            Divider()
            
            // Line Items
            if !data.items.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Items")
                        .font(.headline)
                    
                    ForEach(data.items) { item in
                        HStack {
                            Text(item.description)
                                .font(.body)
                            Spacer()
                            Text(item.formattedAmount)
                                .font(.body)
                                .fontWeight(.medium)
                        }
                    }
                }
            }
            
            Divider()
            
            // Total
            HStack {
                Text("Total")
                    .font(.title3)
                    .fontWeight(.bold)
                Spacer()
                Text(data.formattedTotal)
                    .font(.title3)
                    .fontWeight(.bold)
                    .foregroundStyle(.green)
            }
            
            // Raw text toggle
            DisclosureGroup("View Raw Text") {
                ScrollView {
                    Text(data.rawText)
                        .font(.caption)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 150)
            }
            .font(.caption)
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(radius: 2)
    }
}

#Preview {
    ReceiptProcessingExample()
}
