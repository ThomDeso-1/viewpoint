import SwiftUI
import VisionKit

/// Wraps Apple's `VNDocumentCameraViewController` for use in SwiftUI.
///
/// The scanner provides edge detection, perspective correction, de-skew,
/// and lighting normalisation — all on-device, before images leave the phone.
struct DocumentScannerView: UIViewControllerRepresentable {

    /// Called with the scanned page images (at least one) on success.
    let onScan: ([UIImage]) -> Void

    /// Called if the user taps Cancel.
    let onCancel: () -> Void

    /// Called if VisionKit encounters an error (e.g. camera hardware failure).
    let onError: (Error) -> Void

    // MARK: UIViewControllerRepresentable

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let scanner = VNDocumentCameraViewController()
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(
        _ uiViewController: VNDocumentCameraViewController,
        context: Context
    ) {
        // Nothing to update — the scanner manages its own state.
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    // MARK: Coordinator

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {

        private let parent: DocumentScannerView

        init(parent: DocumentScannerView) {
            self.parent = parent
        }

        func documentCameraViewController(
            _ controller: VNDocumentCameraViewController,
            didFinishWith scan: VNDocumentCameraScan
        ) {
            var images: [UIImage] = []
            for pageIndex in 0 ..< scan.pageCount {
                images.append(scan.imageOfPage(at: pageIndex))
            }
            parent.onScan(images)
        }

        func documentCameraViewControllerDidCancel(
            _ controller: VNDocumentCameraViewController
        ) {
            parent.onCancel()
        }

        func documentCameraViewController(
            _ controller: VNDocumentCameraViewController,
            didFailWithError error: Error
        ) {
            parent.onError(error)
        }
    }
}
