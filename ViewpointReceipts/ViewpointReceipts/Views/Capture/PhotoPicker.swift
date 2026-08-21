import SwiftUI
import PhotosUI

/// Wraps `PHPickerViewController` so the user can pick an existing photo of a
/// receipt from their library, as an alternative to scanning one live with
/// `DocumentScannerView`.
struct PhotoLibraryPickerView: UIViewControllerRepresentable {

    /// Called with the picked image on success.
    let onPick: (UIImage) -> Void

    /// Called if the user dismisses the picker without choosing anything,
    /// or the selected item couldn't be loaded as an image.
    let onCancel: () -> Void

    // MARK: UIViewControllerRepresentable

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var configuration = PHPickerConfiguration()
        configuration.filter = .images
        configuration.selectionLimit = 1

        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(
        _ uiViewController: PHPickerViewController,
        context: Context
    ) {
        // Nothing to update — the picker manages its own state.
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    // MARK: Coordinator

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {

        private let parent: PhotoLibraryPickerView

        init(parent: PhotoLibraryPickerView) {
            self.parent = parent
        }

        func picker(
            _ picker: PHPickerViewController,
            didFinishPicking results: [PHPickerResult]
        ) {
            guard let provider = results.first?.itemProvider,
                  provider.canLoadObject(ofClass: UIImage.self)
            else {
                parent.onCancel()
                return
            }

            provider.loadObject(ofClass: UIImage.self) { image, _ in
                DispatchQueue.main.async {
                    if let image = image as? UIImage {
                        self.parent.onPick(image)
                    } else {
                        self.parent.onCancel()
                    }
                }
            }
        }
    }
}
