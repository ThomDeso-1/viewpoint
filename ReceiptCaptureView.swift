import SwiftUI

/// View that presents options to capture receipt images via camera or file upload
struct ReceiptCaptureView: View {
    @Binding var capturedImage: UIImage?
    @Environment(\.dismiss) var dismiss
    
    @State private var showingImagePicker = false
    @State private var showingCamera = false
    @State private var imageSourceType: UIImagePickerController.SourceType = .camera
    
    var body: some View {
        VStack(spacing: 20) {
            Text("Add Receipt Image")
                .font(.title2)
                .fontWeight(.semibold)
                .padding(.top)
            
            Text("Choose how you'd like to add your receipt")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
            
            Spacer()
            
            VStack(spacing: 16) {
                // Camera Button
                Button {
                    imageSourceType = .camera
                    showingCamera = true
                } label: {
                    Label {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Take Photo")
                                .font(.headline)
                            Text("Use your camera to capture a receipt")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: "camera.fill")
                            .font(.title2)
                            .frame(width: 50)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                    .background(Color.blue.opacity(0.1))
                    .foregroundStyle(.blue)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                
                // Upload from Library Button
                Button {
                    showingImagePicker = true
                } label: {
                    Label {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Upload from Library")
                                .font(.headline)
                            Text("Choose an existing photo from your device")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: "photo.on.rectangle.angled")
                            .font(.title2)
                            .frame(width: 50)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                    .background(Color.green.opacity(0.1))
                    .foregroundStyle(.green)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }
            }
            .padding(.horizontal)
            
            Spacer()
            
            Button("Cancel") {
                dismiss()
            }
            .foregroundStyle(.secondary)
            .padding(.bottom)
        }
        .sheet(isPresented: $showingImagePicker) {
            ModernPhotoPicker(selectedImage: $capturedImage)
        }
        .fullScreenCover(isPresented: $showingCamera) {
            PhotoPickerView(selectedImage: $capturedImage, sourceType: .camera)
                .ignoresSafeArea()
        }
        .onChange(of: capturedImage) { _, newValue in
            if newValue != nil {
                dismiss()
            }
        }
    }
}

#Preview {
    ReceiptCaptureView(capturedImage: .constant(nil))
}
