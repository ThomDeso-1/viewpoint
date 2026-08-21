import SwiftUI
import CoreImage
import CoreImage.CIFilterBuiltins

/// Service for enhancing receipt images
class ImageEnhancementService {
    static let shared = ImageEnhancementService()
    
    private let context = CIContext()
    
    private init() {}
    
    /// Enhance a receipt image for better readability
    func enhanceReceipt(_ image: UIImage) -> UIImage {
        guard let ciImage = CIImage(image: image) else { return image }
        
        // Apply filters in sequence
        var processedImage = ciImage
        
        // 1. Adjust exposure and contrast
        processedImage = adjustExposureAndContrast(processedImage)
        
        // 2. Sharpen the image
        processedImage = sharpenImage(processedImage)
        
        // 3. Convert to black and white for better text clarity
        processedImage = enhanceTextClarity(processedImage)
        
        // Convert back to UIImage
        guard let cgImage = context.createCGImage(processedImage, from: processedImage.extent) else {
            return image
        }
        
        return UIImage(cgImage: cgImage, scale: image.scale, orientation: image.imageOrientation)
    }
    
    /// Apply perspective correction (useful for receipts photographed at an angle)
    func correctPerspective(_ image: UIImage) -> UIImage {
        guard let ciImage = CIImage(image: image) else { return image }
        
        // For automatic perspective correction, we'd need to detect document edges
        // This is a simplified version - in production, use Vision framework
        let filter = CIFilter.perspectiveCorrection()
        filter.inputImage = ciImage
        
        // Default to no correction (would need edge detection)
        guard let outputImage = filter.outputImage,
              let cgImage = context.createCGImage(outputImage, from: outputImage.extent) else {
            return image
        }
        
        return UIImage(cgImage: cgImage, scale: image.scale, orientation: image.imageOrientation)
    }
    
    /// Adjust exposure and contrast for better visibility
    private func adjustExposureAndContrast(_ image: CIImage) -> CIImage {
        let exposureFilter = CIFilter.exposureAdjust()
        exposureFilter.inputImage = image
        exposureFilter.ev = 0.5 // Brighten slightly
        
        guard let exposedImage = exposureFilter.outputImage else { return image }
        
        let contrastFilter = CIFilter.colorControls()
        contrastFilter.inputImage = exposedImage
        contrastFilter.contrast = 1.3 // Increase contrast
        contrastFilter.brightness = 0.1
        
        return contrastFilter.outputImage ?? image
    }
    
    /// Sharpen the image for better text recognition
    private func sharpenImage(_ image: CIImage) -> CIImage {
        let sharpenFilter = CIFilter.sharpenLuminance()
        sharpenFilter.inputImage = image
        sharpenFilter.sharpness = 0.7
        
        return sharpenFilter.outputImage ?? image
    }
    
    /// Enhance text clarity by converting to high-contrast black and white
    private func enhanceTextClarity(_ image: CIImage) -> CIImage {
        // Convert to grayscale
        let grayscaleFilter = CIFilter.photoEffectNoir()
        grayscaleFilter.inputImage = image
        
        guard let grayImage = grayscaleFilter.outputImage else { return image }
        
        // Apply tone curve for high contrast
        let toneCurveFilter = CIFilter.toneCurve()
        toneCurveFilter.inputImage = grayImage
        toneCurveFilter.point0 = CGPoint(x: 0, y: 0)
        toneCurveFilter.point1 = CGPoint(x: 0.25, y: 0.15)
        toneCurveFilter.point2 = CGPoint(x: 0.5, y: 0.5)
        toneCurveFilter.point3 = CGPoint(x: 0.75, y: 0.85)
        toneCurveFilter.point4 = CGPoint(x: 1, y: 1)
        
        return toneCurveFilter.outputImage ?? grayImage
    }
    
    /// Auto-enhance with various presets
    func autoEnhance(_ image: UIImage) -> UIImage {
        guard let ciImage = CIImage(image: image) else { return image }
        
        let filters = ciImage.autoAdjustmentFilters()
        var processedImage = ciImage
        
        for filter in filters {
            filter.setValue(processedImage, forKey: kCIInputImageKey)
            if let output = filter.outputImage {
                processedImage = output
            }
        }
        
        guard let cgImage = context.createCGImage(processedImage, from: processedImage.extent) else {
            return image
        }
        
        return UIImage(cgImage: cgImage, scale: image.scale, orientation: image.imageOrientation)
    }
}

/// View for enhancing receipt images with preview
struct ImageEnhancementView: View {
    @Binding var image: UIImage?
    @Environment(\.dismiss) var dismiss
    
    let originalImage: UIImage
    @State private var enhancedImage: UIImage?
    @State private var selectedFilter: EnhancementFilter = .auto
    @State private var isProcessing = false
    
    enum EnhancementFilter: String, CaseIterable {
        case none = "Original"
        case auto = "Auto Enhance"
        case receipt = "Receipt Mode"
        case brighten = "Brighten"
        case sharpen = "Sharpen"
        
        var icon: String {
            switch self {
            case .none: return "photo"
            case .auto: return "wand.and.stars"
            case .receipt: return "doc.text.image"
            case .brighten: return "sun.max"
            case .sharpen: return "sparkles"
            }
        }
    }
    
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Image preview
                ZStack {
                    Color.black.opacity(0.9)
                    
                    if isProcessing {
                        ProgressView()
                            .scaleEffect(1.5)
                            .tint(.white)
                    } else {
                        Image(uiImage: currentImage)
                            .resizable()
                            .scaledToFit()
                            .padding()
                    }
                }
                .frame(maxHeight: .infinity)
                
                // Filter selection
                VStack(spacing: 12) {
                    Text("Enhancement")
                        .font(.headline)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal)
                    
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 12) {
                            ForEach(EnhancementFilter.allCases, id: \.self) { filter in
                                FilterButton(
                                    filter: filter,
                                    isSelected: selectedFilter == filter
                                ) {
                                    selectedFilter = filter
                                    applyFilter(filter)
                                }
                            }
                        }
                        .padding(.horizontal)
                    }
                }
                .padding(.vertical)
                .background(.ultraThinMaterial)
            }
            .navigationTitle("Enhance Image")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        image = currentImage
                        dismiss()
                    }
                    .fontWeight(.semibold)
                }
            }
            .onAppear {
                applyFilter(.auto)
            }
        }
    }
    
    private var currentImage: UIImage {
        enhancedImage ?? originalImage
    }
    
    private func applyFilter(_ filter: EnhancementFilter) {
        isProcessing = true
        
        Task {
            let processed = await processImage(with: filter)
            
            await MainActor.run {
                enhancedImage = processed
                isProcessing = false
            }
        }
    }
    
    private func processImage(with filter: EnhancementFilter) async -> UIImage? {
        await Task.detached {
            switch filter {
            case .none:
                return originalImage
            case .auto:
                return ImageEnhancementService.shared.autoEnhance(originalImage)
            case .receipt:
                return ImageEnhancementService.shared.enhanceReceipt(originalImage)
            case .brighten:
                return adjustBrightness(originalImage, value: 0.3)
            case .sharpen:
                return sharpen(originalImage)
            }
        }.value
    }
    
    private func adjustBrightness(_ image: UIImage, value: Float) -> UIImage {
        guard let ciImage = CIImage(image: image) else { return image }
        
        let filter = CIFilter.colorControls()
        filter.inputImage = ciImage
        filter.brightness = value
        
        guard let outputImage = filter.outputImage,
              let cgImage = ImageEnhancementService.shared.context.createCGImage(outputImage, from: outputImage.extent) else {
            return image
        }
        
        return UIImage(cgImage: cgImage, scale: image.scale, orientation: image.imageOrientation)
    }
    
    private func sharpen(_ image: UIImage) -> UIImage {
        guard let ciImage = CIImage(image: image) else { return image }
        
        let filter = CIFilter.sharpenLuminance()
        filter.inputImage = ciImage
        filter.sharpness = 1.2
        
        guard let outputImage = filter.outputImage,
              let cgImage = ImageEnhancementService.shared.context.createCGImage(outputImage, from: outputImage.extent) else {
            return image
        }
        
        return UIImage(cgImage: cgImage, scale: image.scale, orientation: image.imageOrientation)
    }
}

struct FilterButton: View {
    let filter: ImageEnhancementView.EnhancementFilter
    let isSelected: Bool
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            VStack(spacing: 8) {
                Image(systemName: filter.icon)
                    .font(.title2)
                    .frame(width: 60, height: 60)
                    .background(isSelected ? Color.blue : Color.gray.opacity(0.2))
                    .foregroundStyle(isSelected ? .white : .primary)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                
                Text(filter.rawValue)
                    .font(.caption)
                    .foregroundStyle(isSelected ? .blue : .secondary)
            }
        }
    }
}

#Preview {
    ImageEnhancementView(
        image: .constant(nil),
        originalImage: UIImage(systemName: "photo")!
    )
}
