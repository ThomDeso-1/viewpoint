import Foundation
import UIKit
import Observation
import CryptoKit

// MARK: - Storage Errors

enum StorageError: LocalizedError {
    case imageConversionFailed
    case noImages
    case icloudUnavailable
    case folderCreationFailed(underlying: Error)

    var errorDescription: String? {
        switch self {
        case .imageConversionFailed:
            return "Failed to convert the scanned image to JPEG."
        case .noImages:
            return "No images were captured from the scanner."
        case .icloudUnavailable:
            return "iCloud Drive is not available. Check that you're signed in to iCloud in Settings."
        case .folderCreationFailed(let err):
            return "Could not create the receipts folder: \(err.localizedDescription)"
        }
    }
}

// MARK: - Storage Service

/// Manages receipt image files on disk — saving, organising into monthly
/// folders, loading thumbnails, and deleting.
///
/// Reads the active storage location from ``AppSettings`` so changes
/// (e.g. a future Settings screen) are picked up automatically.
@Observable
final class StorageService {

    private let settings: AppSettings

    // MARK: Formatters (static, thread-safe)

    private static let fileDateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    private static let monthFolderFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    // MARK: Init

    init(settings: AppSettings) {
        self.settings = settings
    }

    // MARK: Paths

    /// Root folder for all receipt images, determined by the user's storage choice.
    var receiptsRootURL: URL {
        switch settings.storageLocation {
        case .device:
            return FileManager.default
                .urls(for: .documentDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("Receipts", isDirectory: true)

        case .icloud:
            if let container = FileManager.default.url(forUbiquityContainerIdentifier: nil) {
                return container
                    .appendingPathComponent("Documents", isDirectory: true)
                    .appendingPathComponent("Receipts", isDirectory: true)
            }
            // Fallback: iCloud not configured → use local Documents
            return FileManager.default
                .urls(for: .documentDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("Receipts", isDirectory: true)
        }
    }

    /// Whether the device currently has an iCloud identity (signed in).
    var isICloudAvailable: Bool {
        FileManager.default.ubiquityIdentityToken != nil
    }

    /// "2026-08" style folder name for a given date.
    func monthFolderName(for date: Date) -> String {
        Self.monthFolderFormatter.string(from: date)
    }

    /// Full URL of a file given its path relative to ``receiptsRootURL``.
    func imageURL(forPath relativePath: String) -> URL {
        receiptsRootURL.appendingPathComponent(relativePath)
    }

    // MARK: Folder management

    /// Create the receipts root if it doesn't exist.
    func ensureReceiptsRoot() throws {
        try FileManager.default.createDirectory(
            at: receiptsRootURL,
            withIntermediateDirectories: true
        )
    }

    /// Create (or confirm) the month subfolder and return its URL.
    @discardableResult
    func ensureMonthFolder(for date: Date) throws -> URL {
        let folderURL = receiptsRootURL.appendingPathComponent(
            monthFolderName(for: date), isDirectory: true
        )
        try FileManager.default.createDirectory(
            at: folderURL,
            withIntermediateDirectories: true
        )
        return folderURL
    }

    // MARK: Save

    /// Save one or more scanned page images into the correct monthly folder.
    ///
    /// Returns relative paths (from ``receiptsRootURL``) so they can be
    /// stored in the ``Receipt`` model.
    func saveReceiptImages(
        _ images: [UIImage],
        date: Date
    ) throws -> (primaryPath: String, additionalPaths: [String]) {

        guard !images.isEmpty else { throw StorageError.noImages }

        let month      = monthFolderName(for: date)
        let folderURL  = try ensureMonthFolder(for: date)
        let dateString = Self.fileDateFormatter.string(from: date)
        let batchId    = UUID().uuidString.prefix(8).lowercased()

        var relativePaths: [String] = []

        for (index, image) in images.enumerated() {
            let pageSuffix = images.count > 1 ? "_p\(index + 1)" : ""
            let fileName   = "\(dateString)_\(batchId)\(pageSuffix).jpg"
            let fileURL    = folderURL.appendingPathComponent(fileName)

            guard let data = image.jpegData(compressionQuality: 0.85) else {
                throw StorageError.imageConversionFailed
            }
            try data.write(to: fileURL, options: .atomic)
            relativePaths.append("\(month)/\(fileName)")
        }

        return (relativePaths[0], Array(relativePaths.dropFirst()))
    }

    // MARK: Load

    /// Load the full-resolution image from disk. Returns nil if the file is missing.
    func loadImage(forPath relativePath: String) -> UIImage? {
        let url = imageURL(forPath: relativePath)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return UIImage(contentsOfFile: url.path)
    }

    // MARK: Delete

    /// Remove all image files associated with a receipt.
    func deleteReceiptFiles(primaryPath: String, additionalPaths: [String]) {
        let allPaths = [primaryPath] + additionalPaths
        for path in allPaths {
            let url = imageURL(forPath: path)
            try? FileManager.default.removeItem(at: url)
        }
        // Clean up empty month folders
        for path in allPaths {
            let folderURL = imageURL(forPath: path).deletingLastPathComponent()
            let contents = try? FileManager.default.contentsOfDirectory(atPath: folderURL.path)
            if let contents, contents.isEmpty {
                try? FileManager.default.removeItem(at: folderURL)
            }
        }
    }

    // MARK: Move (for date changes)

    /// Move a receipt's image file to a different month folder when its date is edited.
    /// Returns the new relative path.
    func moveReceiptImage(from oldPath: String, toDate newDate: Date) throws -> String {
        let oldURL      = imageURL(forPath: oldPath)
        let newMonth    = monthFolderName(for: newDate)
        let _           = try ensureMonthFolder(for: newDate)
        let fileName    = oldURL.lastPathComponent
        let newRelative = "\(newMonth)/\(fileName)"
        let newURL      = imageURL(forPath: newRelative)

        // Don't move if already in the right folder
        guard oldPath != newRelative else { return oldPath }

        try FileManager.default.moveItem(at: oldURL, to: newURL)
        return newRelative
    }

    // MARK: - Sidecar Files

    /// URL for the JSON sidecar that accompanies a receipt image.
    /// Same name as the image but with a `.json` extension.
    func sidecarURL(forImagePath relativePath: String) -> URL {
        let imageURL = imageURL(forPath: relativePath)
        return imageURL.deletingPathExtension().appendingPathExtension("json")
    }

    /// Save a ``ReceiptSidecar`` as a JSON file alongside the receipt image.
    func saveSidecar(_ sidecar: ReceiptSidecar, forImagePath relativePath: String) {
        let url = sidecarURL(forImagePath: relativePath)
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            encoder.dateEncodingStrategy = .iso8601
            let data = try encoder.encode(sidecar)
            try data.write(to: url, options: .atomic)
        } catch {
            // Sidecar save is best-effort; the SwiftData model is the primary record.
            print("⚠️ Failed to save sidecar at \(url.lastPathComponent): \(error)")
        }
    }

    /// Load a ``ReceiptSidecar`` from disk, or `nil` if it doesn't exist.
    func loadSidecar(forImagePath relativePath: String) -> ReceiptSidecar? {
        let url = sidecarURL(forImagePath: relativePath)
        guard let data = try? Data(contentsOf: url) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(ReceiptSidecar.self, from: data)
    }

    /// Move a sidecar file to match a moved image.
    func moveSidecar(fromImagePath oldPath: String, toImagePath newPath: String) {
        let oldURL = sidecarURL(forImagePath: oldPath)
        let newURL = sidecarURL(forImagePath: newPath)
        guard oldURL != newURL,
              FileManager.default.fileExists(atPath: oldURL.path) else { return }
        try? FileManager.default.moveItem(at: oldURL, to: newURL)
    }

    // MARK: Delete (updated)

    /// Remove sidecar files associated with a receipt.
    func deleteSidecarFiles(primaryPath: String, additionalPaths: [String]) {
        let allPaths = [primaryPath] + additionalPaths
        for path in allPaths {
            let url = sidecarURL(forImagePath: path)
            try? FileManager.default.removeItem(at: url)
        }
    }

    // MARK: - Image Hash

    /// Compute a SHA-256 hash of the primary receipt image data for duplicate detection.
    func computeImageHash(forPath relativePath: String) -> String? {
        let url = imageURL(forPath: relativePath)
        guard let data = try? Data(contentsOf: url) else { return nil }
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
