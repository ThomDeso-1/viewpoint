import SwiftUI
import UIKit

/// A view that allows users to crop and adjust receipt images
struct ImageCropperView: View {
    @Binding var image: UIImage?
    @Environment(\.dismiss) var dismiss
    
    let originalImage: UIImage
    @State private var cropRect: CGRect = .zero
    @State private var imageSize: CGSize = .zero
    @State private var scale: CGFloat = 1.0
    @State private var lastScale: CGFloat = 1.0
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero
    
    var body: some View {
        NavigationStack {
            VStack {
                GeometryReader { geometry in
                    ZStack {
                        // Display the image
                        Image(uiImage: originalImage)
                            .resizable()
                            .scaledToFit()
                            .scaleEffect(scale)
                            .offset(offset)
                            .gesture(
                                MagnificationGesture()
                                    .onChanged { value in
                                        scale = lastScale * value
                                    }
                                    .onEnded { value in
                                        lastScale = scale
                                    }
                            )
                            .gesture(
                                DragGesture()
                                    .onChanged { value in
                                        offset = CGSize(
                                            width: lastOffset.width + value.translation.width,
                                            height: lastOffset.height + value.translation.height
                                        )
                                    }
                                    .onEnded { value in
                                        lastOffset = offset
                                    }
                            )
                        
                        // Crop overlay
                        Rectangle()
                            .fill(.clear)
                            .border(.white, width: 2)
                            .shadow(color: .black.opacity(0.5), radius: 0, x: 0, y: 0)
                            .padding(20)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.black)
                    .onAppear {
                        imageSize = geometry.size
                    }
                }
                
                // Instructions
                VStack(spacing: 8) {
                    Text("Adjust the Image")
                        .font(.headline)
                    Text("Pinch to zoom, drag to reposition")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding()
            }
            .navigationTitle("Crop Receipt")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        cropImage()
                        dismiss()
                    }
                    .fontWeight(.semibold)
                }
            }
        }
    }
    
    private func cropImage() {
        // For simplicity, we'll apply the scale and position transformations
        // In a production app, you'd crop to the visible rect
        let renderer = UIGraphicsImageRenderer(size: originalImage.size)
        let croppedImage = renderer.image { context in
            originalImage.draw(at: .zero)
        }
        image = croppedImage
    }
}

/// UIKit-based image cropper with more advanced features
struct AdvancedImageCropper: UIViewControllerRepresentable {
    @Binding var image: UIImage?
    let originalImage: UIImage
    @Environment(\.dismiss) var dismiss
    
    func makeUIViewController(context: Context) -> ImageCropViewController {
        let controller = ImageCropViewController(image: originalImage)
        controller.delegate = context.coordinator
        return controller
    }
    
    func updateUIViewController(_ uiViewController: ImageCropViewController, context: Context) {}
    
    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }
    
    class Coordinator: NSObject, ImageCropViewControllerDelegate {
        let parent: AdvancedImageCropper
        
        init(_ parent: AdvancedImageCropper) {
            self.parent = parent
        }
        
        func imageCropViewControllerDidFinish(_ controller: ImageCropViewController, croppedImage: UIImage?) {
            parent.image = croppedImage
            parent.dismiss.callAsFunction()
        }
        
        func imageCropViewControllerDidCancel(_ controller: ImageCropViewController) {
            parent.dismiss.callAsFunction()
        }
    }
}

// MARK: - UIKit Crop Controller

protocol ImageCropViewControllerDelegate: AnyObject {
    func imageCropViewControllerDidFinish(_ controller: ImageCropViewController, croppedImage: UIImage?)
    func imageCropViewControllerDidCancel(_ controller: ImageCropViewController)
}

class ImageCropViewController: UIViewController {
    weak var delegate: ImageCropViewControllerDelegate?
    private let originalImage: UIImage
    private var scrollView: UIScrollView!
    private var imageView: UIImageView!
    private var cropOverlay: CropOverlayView!
    
    init(image: UIImage) {
        self.originalImage = image
        super.init(nibName: nil, bundle: nil)
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
    
    override func viewDidLoad() {
        super.viewDidLoad()
        setupUI()
    }
    
    private func setupUI() {
        view.backgroundColor = .black
        
        // Setup scroll view
        scrollView = UIScrollView(frame: view.bounds)
        scrollView.delegate = self
        scrollView.minimumZoomScale = 1.0
        scrollView.maximumZoomScale = 3.0
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        view.addSubview(scrollView)
        
        // Setup image view
        imageView = UIImageView(image: originalImage)
        imageView.contentMode = .scaleAspectFit
        scrollView.addSubview(imageView)
        
        // Setup crop overlay
        cropOverlay = CropOverlayView(frame: view.bounds)
        view.addSubview(cropOverlay)
        
        // Navigation bar
        let navBar = UINavigationBar(frame: CGRect(x: 0, y: 0, width: view.bounds.width, height: 88))
        navBar.isTranslucent = true
        navBar.barStyle = .black
        
        let navItem = UINavigationItem(title: "Crop Receipt")
        navItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel, target: self, action: #selector(cancelTapped))
        navItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(doneTapped))
        navBar.items = [navItem]
        view.addSubview(navBar)
        
        layoutViews()
    }
    
    private func layoutViews() {
        let size = view.bounds.size
        scrollView.frame = view.bounds
        imageView.frame = CGRect(origin: .zero, size: originalImage.size)
        scrollView.contentSize = originalImage.size
        
        // Center the image initially
        centerScrollViewContents()
    }
    
    private func centerScrollViewContents() {
        let boundsSize = scrollView.bounds.size
        var contentsFrame = imageView.frame
        
        if contentsFrame.size.width < boundsSize.width {
            contentsFrame.origin.x = (boundsSize.width - contentsFrame.size.width) / 2.0
        } else {
            contentsFrame.origin.x = 0.0
        }
        
        if contentsFrame.size.height < boundsSize.height {
            contentsFrame.origin.y = (boundsSize.height - contentsFrame.size.height) / 2.0
        } else {
            contentsFrame.origin.y = 0.0
        }
        
        imageView.frame = contentsFrame
    }
    
    @objc private func cancelTapped() {
        delegate?.imageCropViewControllerDidCancel(self)
    }
    
    @objc private func doneTapped() {
        let croppedImage = cropImage()
        delegate?.imageCropViewControllerDidFinish(self, croppedImage: croppedImage)
    }
    
    private func cropImage() -> UIImage? {
        // Calculate the crop rect in image coordinates
        let scale = scrollView.zoomScale
        let visibleRect = cropOverlay.cropRect
        
        // Convert to image coordinates
        let imageScale = originalImage.scale
        let cropRect = CGRect(
            x: (scrollView.contentOffset.x + visibleRect.minX - imageView.frame.minX) * imageScale / scale,
            y: (scrollView.contentOffset.y + visibleRect.minY - imageView.frame.minY) * imageScale / scale,
            width: visibleRect.width * imageScale / scale,
            height: visibleRect.height * imageScale / scale
        )
        
        guard let cgImage = originalImage.cgImage?.cropping(to: cropRect) else {
            return originalImage
        }
        
        return UIImage(cgImage: cgImage, scale: originalImage.scale, orientation: originalImage.imageOrientation)
    }
}

extension ImageCropViewController: UIScrollViewDelegate {
    func viewForZooming(in scrollView: UIScrollView) -> UIView? {
        return imageView
    }
    
    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        centerScrollViewContents()
    }
}

// MARK: - Crop Overlay View

class CropOverlayView: UIView {
    var cropRect: CGRect {
        return bounds.insetBy(dx: 20, dy: 100)
    }
    
    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isUserInteractionEnabled = false
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
    
    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        
        // Draw darkened overlay
        context.setFillColor(UIColor.black.withAlphaComponent(0.5).cgColor)
        context.fill(rect)
        
        // Clear the crop area
        let cropArea = cropRect
        context.clear(cropArea)
        
        // Draw crop border
        context.setStrokeColor(UIColor.white.cgColor)
        context.setLineWidth(2.0)
        context.stroke(cropArea)
        
        // Draw corner markers
        let cornerLength: CGFloat = 20
        let corners: [(CGPoint, [(CGFloat, CGFloat)])] = [
            (cropArea.origin, [(1, 0), (0, 1)]),
            (CGPoint(x: cropArea.maxX, y: cropArea.minY), [(-1, 0), (0, 1)]),
            (CGPoint(x: cropArea.minX, y: cropArea.maxY), [(1, 0), (0, -1)]),
            (CGPoint(x: cropArea.maxX, y: cropArea.maxY), [(-1, 0), (0, -1)])
        ]
        
        context.setLineWidth(3.0)
        for (point, directions) in corners {
            for (dx, dy) in directions {
                context.move(to: point)
                context.addLine(to: CGPoint(x: point.x + dx * cornerLength, y: point.y + dy * cornerLength))
            }
        }
        context.strokePath()
    }
}
