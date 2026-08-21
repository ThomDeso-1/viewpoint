# Receipt Scanner with Image Upload, Cropping, and Enhancement

A complete receipt scanning solution for iOS with camera capture, file upload, image editing, and OCR processing.

## 🎯 Features

### 📸 Image Capture
- **Camera Capture**: Take photos directly with device camera
- **File Upload**: Browse and select existing photos from library
- **Unified Interface**: Single button presents both options

### ✂️ Image Editing
- **Cropping**: Advanced cropping with pinch-to-zoom and pan gestures
- **Enhancement**: Multiple filter options optimized for receipt clarity
  - Auto Enhance
  - Receipt Mode (high contrast B&W)
  - Brightness adjustment
  - Sharpening

### 🔍 OCR Processing
- **Vision Framework Integration**: Native Apple OCR
- **Structured Data Extraction**:
  - Store name
  - Date
  - Total amount
  - Line items with prices
  - Raw text output
- **Auto Enhancement**: Images are automatically enhanced before OCR

## 📁 File Structure

```
├── PhotoPicker.swift              # Camera & photo library pickers
├── ReceiptCaptureView.swift       # Main capture interface
├── ImageCropperView.swift         # Advanced image cropping
├── ImageEnhancementView.swift     # Image enhancement filters
├── ReceiptOCRService.swift        # Vision OCR & data parsing
└── ReceiptProcessingExample.swift # Main integrated view
```

## 🚀 Quick Start

### 1. Add Privacy Permissions

Add these keys to your `Info.plist`:

```xml
<key>NSCameraUsageDescription</key>
<string>We need camera access to capture receipt images</string>

<key>NSPhotoLibraryUsageDescription</key>
<string>We need access to your photo library to upload receipt images</string>
```

### 2. Use in Your App

```swift
import SwiftUI

struct ContentView: View {
    @State private var receiptImage: UIImage?
    @State private var showingCapture = false
    
    var body: some View {
        Button("Scan Receipt") {
            showingCapture = true
        }
        .sheet(isPresented: $showingCapture) {
            ReceiptCaptureView(capturedImage: $receiptImage)
        }
        .onChange(of: receiptImage) { _, newImage in
            if let image = newImage {
                // Process the receipt
                processReceipt(image)
            }
        }
    }
    
    func processReceipt(_ image: UIImage) {
        Task {
            do {
                let data = try await ReceiptOCRService.shared.extractReceiptData(from: image)
                print("Store: \(data.storeName ?? "Unknown")")
                print("Total: \(data.formattedTotal)")
            } catch {
                print("Error: \(error)")
            }
        }
    }
}
```

## 🔧 Integration with Existing Code

The complete workflow is demonstrated in `ReceiptProcessingExample.swift`. It shows:

1. **Image Capture**: Camera or upload selection
2. **Optional Editing**: Crop and enhance buttons
3. **Automatic Processing**: OCR with Vision framework
4. **Data Display**: Structured receipt information
5. **Error Handling**: Graceful failure management

### Processing Pipeline

```
Capture/Upload → Crop (optional) → Enhance (optional) → Auto-enhance → OCR → Parse → Display
```

## 🎨 Customization

### Enhance OCR Accuracy

Modify `ImageEnhancementService.swift`:

```swift
// Adjust contrast values
contrastFilter.contrast = 1.5  // Default: 1.3

// Change sharpness
sharpenFilter.sharpness = 1.0  // Default: 0.7
```

### Customize Parsing

Edit `ReceiptOCRService.swift` to add custom patterns:

```swift
private func extractTotal(from text: String) -> Decimal? {
    // Add your custom total patterns here
    let customPattern = "grand total[:\\s]*\\$?([\\d,]+\\.\\d{2})"
    // ...
}
```

### Add Database Storage

In `ReceiptProcessingExample.swift`:

```swift
private func processReceipt(_ image: UIImage) {
    processingStep = .process
    isProcessing = true
    
    Task {
        do {
            let data = try await ReceiptOCRService.shared.extractReceiptData(from: image)
            
            // Add your database save here
            await saveToDatabase(data)
            
            await MainActor.run {
                receiptData = data
                isProcessing = false
                processingStep = .complete
            }
        } catch {
            // Handle errors
        }
    }
}

func saveToDatabase(_ data: ReceiptData) async {
    // Your database logic (Core Data, SwiftData, etc.)
}
```

## 🧪 Testing

The app includes a complete example view that you can run immediately:

1. Run the app
2. Tap "Add Receipt"
3. Choose "Take Photo" or "Upload from Library"
4. Optionally crop/enhance
5. View extracted data

## 📱 Requirements

- iOS 14.0+ (for PHPicker)
- iOS 13.0+ (for Vision OCR)
- Camera and Photo Library permissions

## 🔐 Privacy

- All processing happens on-device
- No images or data sent to external servers
- Vision framework runs locally
- User controls photo permissions

## 💡 Tips for Best Results

1. **Lighting**: Ensure good, even lighting when capturing receipts
2. **Contrast**: Use high-contrast receipts (avoid faded receipts)
3. **Angle**: Hold camera parallel to receipt for best results
4. **Enhancement**: Use "Receipt Mode" filter for thermal/faded receipts
5. **Cropping**: Remove background to focus on receipt content

## 🐛 Troubleshooting

### OCR Not Working
- Check that Vision framework is imported
- Verify image quality (not too small/blurry)
- Try the enhancement filters first

### Camera Not Opening
- Verify Info.plist permissions
- Check device camera availability
- Ensure running on real device (not simulator)

### Poor OCR Results
- Use the "Receipt Mode" enhancement
- Crop to receipt boundaries only
- Ensure receipt text is straight (not angled)
- Check for adequate lighting in photo

## 🚧 Future Enhancements

Ideas for extending this implementation:

- [ ] PDF export of receipts
- [ ] Category auto-detection
- [ ] Multi-receipt batch processing
- [ ] Cloud backup integration
- [ ] Expense report generation
- [ ] Tax category tagging
- [ ] Receipt search functionality
- [ ] Duplicate detection

## 📄 License

This code is provided as-is for integration into your project.
