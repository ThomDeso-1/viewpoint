import SwiftUI

/// Onboarding step 2: the user pastes their Claude API key,
/// the app validates it, and stores it in the Keychain.
struct APIKeySetupView: View {

    let onComplete: () -> Void

    @Environment(AppSettings.self) private var settings
    @State private var apiKey = ""
    @State private var isValidating = false
    @State private var validationError: String?
    @State private var isValid = false

    var body: some View {
        VStack(spacing: 32) {

            // MARK: Header

            VStack(spacing: 12) {
                Image(systemName: "key.fill")
                    .font(.system(size: 56))
                    .foregroundStyle(.tint)

                Text("Claude API Key")
                    .font(.largeTitle.bold())

                Text("Paste your Claude API key to enable receipt data extraction. The key is stored securely in the iOS Keychain.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
            }
            .padding(.top, 48)

            // MARK: Input

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    SecureField("sk-ant-api03-...", text: $apiKey)
                        .textContentType(.none)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .font(.system(.body, design: .monospaced))
                        .onChange(of: apiKey) { _, _ in
                            isValid = false
                            validationError = nil
                        }

                    if !apiKey.isEmpty {
                        Button {
                            apiKey = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .padding()
                .background {
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(
                            borderColor,
                            lineWidth: 1
                        )
                }

                if let error = validationError {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                }

                if isValid {
                    Label("Key validated successfully", systemImage: "checkmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.green)
                }
            }
            .padding(.horizontal, 20)

            Spacer()

            // MARK: Actions

            VStack(spacing: 12) {
                Button {
                    Task { await validateAndSave() }
                } label: {
                    Group {
                        if isValidating {
                            ProgressView()
                                .tint(.white)
                        } else if isValid {
                            Label("Continue", systemImage: "checkmark")
                        } else {
                            Text("Validate & Save")
                        }
                    }
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .disabled(apiKey.trimmingCharacters(in: .whitespaces).isEmpty || isValidating)

                Button {
                    skipSetup()
                } label: {
                    Text("Skip for Now")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 36)
        }
    }

    // MARK: - Helpers

    private var borderColor: Color {
        if validationError != nil { return .red }
        if isValid { return .green }
        return .secondary.opacity(0.3)
    }

    // MARK: - Actions

    private func validateAndSave() async {
        let trimmed = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        // If already validated, just proceed
        if isValid {
            onComplete()
            return
        }

        isValidating = true
        validationError = nil

        do {
            try await ClaudeAPIService.shared.validateApiKey(trimmed)
            try KeychainService.shared.save(trimmed, forKey: KeychainService.Keys.claudeApiKey)
            isValid = true
            settings.hasClaudeApiKey = true

            // Brief pause so the user sees the success state
            try? await Task.sleep(for: .milliseconds(600))
            onComplete()
        } catch let error as ClaudeAPIError {
            validationError = error.localizedDescription
        } catch {
            validationError = error.localizedDescription
        }

        isValidating = false
    }

    private func skipSetup() {
        // The user can add the key later in Settings.
        settings.hasClaudeApiKey = false
        onComplete()
    }
}
