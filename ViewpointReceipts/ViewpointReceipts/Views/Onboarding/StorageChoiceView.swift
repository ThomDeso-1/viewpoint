import SwiftUI

/// First-run screen: the user picks where receipt images are stored.
struct StorageChoiceView: View {

    /// Called when the user taps Continue — advances to the next onboarding step.
    let onContinue: () -> Void

    @Environment(AppSettings.self) private var settings
    @Environment(StorageService.self) private var storageService
    @State private var selectedLocation: StorageLocation?

    var body: some View {
        NavigationStack {
            VStack(spacing: 32) {

                // MARK: Header

                VStack(spacing: 12) {
                    Image(systemName: "doc.viewfinder")
                        .font(.system(size: 56))
                        .foregroundStyle(.tint)

                    Text("Welcome to Viewpoint")
                        .font(.largeTitle.bold())

                    Text("Choose where to store your receipt images and data.")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }
                .padding(.top, 48)

                // MARK: Options

                VStack(spacing: 16) {
                    StorageOptionCard(
                        title: "On My iPhone",
                        detail: "Receipts stay on this device. Back up with your regular iPhone backup.",
                        icon: "iphone",
                        isSelected: selectedLocation == .device
                    ) {
                        selectedLocation = .device
                    }

                    StorageOptionCard(
                        title: "iCloud Drive",
                        detail: storageService.isICloudAvailable
                            ? "Receipts sync to your other Apple devices and are browsable in the Files app."
                            : "Sign in to iCloud in Settings to use this option.",
                        icon: "icloud",
                        isSelected: selectedLocation == .icloud,
                        isDisabled: !storageService.isICloudAvailable
                    ) {
                        guard storageService.isICloudAvailable else { return }
                        selectedLocation = .icloud
                    }
                }
                .padding(.horizontal, 20)

                Spacer()

                // MARK: Continue

                Button {
                    completeStorageChoice()
                } label: {
                    Text("Continue")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .disabled(selectedLocation == nil)
                .padding(.horizontal, 20)
                .padding(.bottom, 36)
            }
        }
    }

    // MARK: - Actions

    private func completeStorageChoice() {
        guard let location = selectedLocation else { return }

        settings.storageLocation = location

        // Best-effort: pre-create the root folder so the first capture is fast.
        try? storageService.ensureReceiptsRoot()

        onContinue()
    }
}

// MARK: - Storage Option Card

private struct StorageOptionCard: View {

    let title: String
    let detail: String
    let icon: String
    let isSelected: Bool
    var isDisabled: Bool = false
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 16) {
                Image(systemName: icon)
                    .font(.title2)
                    .foregroundStyle(isDisabled ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.tint))
                    .frame(width: 36)

                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.headline)
                        .foregroundStyle(isDisabled ? .tertiary : .primary)

                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(isDisabled ? .tertiary : .secondary)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer()

                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.tint)
                        .font(.title3)
                }
            }
            .padding()
            .background {
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(
                        isSelected ? Color.accentColor : Color.secondary.opacity(0.25),
                        lineWidth: isSelected ? 2 : 1
                    )
                    .background(
                        RoundedRectangle(cornerRadius: 12)
                            .fill(isSelected ? Color.accentColor.opacity(0.06) : .clear)
                    )
            }
        }
        .disabled(isDisabled)
        .accessibilityLabel("\(title). \(detail)")
    }
}
