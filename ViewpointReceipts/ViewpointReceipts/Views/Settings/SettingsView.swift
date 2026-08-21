import SwiftUI

/// Post-onboarding settings screen accessible from the receipt list.
struct SettingsView: View {

    @Environment(AppSettings.self) private var settings
    @Environment(UploadService.self) private var uploadService
    @Environment(\.modelContext) private var modelContext
    @Environment(\.dismiss) private var dismiss

    @State private var showingResetConfirmation = false

    var body: some View {
        NavigationStack {
            List {
                // MARK: Storage
                Section("Storage") {
                    HStack {
                        Text("Location")
                        Spacer()
                        Text(settings.storageLocation.displayName)
                            .foregroundStyle(.secondary)
                    }
                }

                // MARK: Claude API
                Section("Claude API") {
                    HStack {
                        Text("API Key")
                        Spacer()
                        if settings.hasClaudeApiKey {
                            Label("Connected", systemImage: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                                .font(.subheadline)
                        } else {
                            Text("Not Set")
                                .foregroundStyle(.secondary)
                        }
                    }

                    if settings.hasClaudeApiKey {
                        Button("Remove API Key", role: .destructive) {
                            KeychainService.shared.delete(forKey: KeychainService.Keys.claudeApiKey)
                            settings.hasClaudeApiKey = false
                        }
                    }
                }

                // MARK: Wave
                Section("Wave Accounting") {
                    if settings.hasWaveToken {
                        HStack {
                            Text("Business")
                            Spacer()
                            Text(settings.waveBusinessName.isEmpty ? "Unknown" : settings.waveBusinessName)
                                .foregroundStyle(.secondary)
                        }

                        HStack {
                            Text("Status")
                            Spacer()
                            Label("Connected", systemImage: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                                .font(.subheadline)
                        }

                        Button("Disconnect Wave", role: .destructive) {
                            disconnectWave()
                        }
                    } else {
                        HStack {
                            Text("Status")
                            Spacer()
                            Text("Not Connected")
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                // MARK: Upload Queue
                if settings.hasWaveToken {
                    Section("Upload Queue") {
                        HStack {
                            Text("Uploaded")
                            Spacer()
                            Text("\(uploadService.uploadedCount)")
                                .foregroundStyle(.secondary)
                        }
                        HStack {
                            Text("Pending")
                            Spacer()
                            Text("\(uploadService.pendingCount)")
                                .foregroundStyle(.secondary)
                        }
                        HStack {
                            Text("Failed")
                            Spacer()
                            Text("\(uploadService.failedCount)")
                                .foregroundStyle(uploadService.failedCount > 0 ? .red : .secondary)
                        }

                        if uploadService.failedCount > 0 {
                            Button {
                                uploadService.retryAll(modelContext: modelContext)
                            } label: {
                                Label("Retry All Failed", systemImage: "arrow.clockwise")
                            }
                        }
                    }
                }

                // MARK: About
                Section("About") {
                    HStack {
                        Text("Version")
                        Spacer()
                        Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                if settings.hasWaveToken {
                    await uploadService.updateCounts(modelContext: modelContext)
                }
            }
        }
    }

    private func disconnectWave() {
        KeychainService.shared.delete(forKey: KeychainService.Keys.waveAccessToken)
        settings.hasWaveToken = false
        settings.waveBusinessId = ""
        settings.waveBusinessName = ""
        settings.waveExpenseAccountId = ""
        settings.waveAnchorAccountId = ""
        settings.waveSalesTaxId = ""
        uploadService.stopProcessing()
    }
}
