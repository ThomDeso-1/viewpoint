import SwiftUI

/// Onboarding step 3: the user pastes their Wave access token,
/// validates it, picks their business, and the app auto-discovers
/// tax rates and accounts.
struct WaveSetupView: View {

    let onComplete: () -> Void

    @Environment(AppSettings.self) private var settings
    @State private var accessToken = ""
    @State private var step: SetupStep = .token
    @State private var isLoading = false
    @State private var errorMessage: String?

    // Discovered data
    @State private var businesses: [WaveBusiness] = []
    @State private var selectedBusiness: WaveBusiness?
    @State private var expenseAccounts: [WaveAccount] = []
    @State private var anchorAccounts: [WaveAccount] = []
    @State private var salesTaxes: [WaveSalesTax] = []
    @State private var selectedExpenseAccount: WaveAccount?
    @State private var selectedAnchorAccount: WaveAccount?
    @State private var selectedSalesTax: WaveSalesTax?

    private enum SetupStep {
        case token
        case pickBusiness
        case configureAccounts
    }

    var body: some View {
        VStack(spacing: 32) {
            header
            Spacer()
            stepContent
            Spacer()
            actions
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(spacing: 12) {
            Image(systemName: "waveform.path.ecg")
                .font(.system(size: 56))
                .foregroundStyle(.tint)

            Text("Connect Wave")
                .font(.largeTitle.bold())

            Text(headerSubtitle)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
        }
        .padding(.top, 48)
    }

    private var headerSubtitle: String {
        switch step {
        case .token:
            return "Paste your Wave full-access token to enable receipt uploads."
        case .pickBusiness:
            return "Select the business to record expenses against."
        case .configureAccounts:
            return "Confirm your default expense account, payment method, and sales tax."
        }
    }

    // MARK: - Step Content

    @ViewBuilder
    private var stepContent: some View {
        switch step {
        case .token:
            tokenInput
        case .pickBusiness:
            businessPicker
        case .configureAccounts:
            accountConfig
        }
    }

    // MARK: Token Input

    private var tokenInput: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                SecureField("Wave access token", text: $accessToken)
                    .textContentType(.none)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .font(.system(.body, design: .monospaced))

                if !accessToken.isEmpty {
                    Button { accessToken = "" } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding()
            .background {
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(
                        errorMessage != nil ? Color.red : Color.secondary.opacity(0.3),
                        lineWidth: 1
                    )
            }

            if let error = errorMessage {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .padding(.horizontal, 20)
    }

    // MARK: Business Picker

    private var businessPicker: some View {
        VStack(spacing: 12) {
            ForEach(businesses.filter { !$0.isPersonal }) { biz in
                Button {
                    selectedBusiness = biz
                } label: {
                    HStack {
                        VStack(alignment: .leading) {
                            Text(biz.name)
                                .font(.headline)
                                .foregroundStyle(.primary)
                        }
                        Spacer()
                        if selectedBusiness?.id == biz.id {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.tint)
                        }
                    }
                    .padding()
                    .background {
                        RoundedRectangle(cornerRadius: 10)
                            .strokeBorder(
                                selectedBusiness?.id == biz.id
                                    ? Color.accentColor
                                    : Color.secondary.opacity(0.25),
                                lineWidth: selectedBusiness?.id == biz.id ? 2 : 1
                            )
                    }
                }
            }
        }
        .padding(.horizontal, 20)
    }

    // MARK: Account Configuration

    private var accountConfig: some View {
        VStack(spacing: 0) {
            pickerRow("Expense Account") {
                Picker("", selection: $selectedExpenseAccount) {
                    Text("Select…").tag(nil as WaveAccount?)
                    ForEach(expenseAccounts) { acct in
                        Text(acct.name).tag(acct as WaveAccount?)
                    }
                }
                .labelsHidden()
            }
            Divider().padding(.leading)

            pickerRow("Pay From") {
                Picker("", selection: $selectedAnchorAccount) {
                    Text("Select…").tag(nil as WaveAccount?)
                    ForEach(anchorAccounts) { acct in
                        Text(acct.name).tag(acct as WaveAccount?)
                    }
                }
                .labelsHidden()
            }
            Divider().padding(.leading)

            pickerRow("Sales Tax") {
                Picker("", selection: $selectedSalesTax) {
                    Text("None").tag(nil as WaveSalesTax?)
                    ForEach(salesTaxes) { tax in
                        Text("\(tax.name) (\(Int(tax.rate * 100))%)")
                            .tag(tax as WaveSalesTax?)
                    }
                }
                .labelsHidden()
            }

            if let error = errorMessage {
                Divider().padding(.leading)
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.vertical, 10)
            }
        }
        .padding(.horizontal, 20)
    }

    private func pickerRow<Content: View>(
        _ label: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer()
            content()
        }
        .padding(.vertical, 6)
    }

    // MARK: - Actions

    private var actions: some View {
        VStack(spacing: 12) {
            Button {
                Task { await primaryAction() }
            } label: {
                Group {
                    if isLoading {
                        ProgressView().tint(.white)
                    } else {
                        Text(primaryButtonTitle)
                    }
                }
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent)
            .disabled(isPrimaryDisabled)

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

    private var primaryButtonTitle: String {
        switch step {
        case .token: return "Validate & Connect"
        case .pickBusiness: return "Continue"
        case .configureAccounts: return "Finish Setup"
        }
    }

    private var isPrimaryDisabled: Bool {
        if isLoading { return true }
        switch step {
        case .token: return accessToken.trimmingCharacters(in: .whitespaces).isEmpty
        case .pickBusiness: return selectedBusiness == nil
        case .configureAccounts: return selectedExpenseAccount == nil || selectedAnchorAccount == nil
        }
    }

    // MARK: - Action Logic

    private func primaryAction() async {
        isLoading = true
        errorMessage = nil

        switch step {
        case .token:
            await validateToken()
        case .pickBusiness:
            await discoverAccounts()
        case .configureAccounts:
            finishSetup()
        }

        isLoading = false
    }

    private func validateToken() async {
        let trimmed = accessToken.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            businesses = try await WaveAPIService.shared.validateToken(trimmed)
            try KeychainService.shared.save(trimmed, forKey: KeychainService.Keys.waveAccessToken)

            // If only one non-personal business, auto-select
            let bizList = businesses.filter { !$0.isPersonal }
            if bizList.count == 1 {
                selectedBusiness = bizList[0]
                await discoverAccounts()
            } else {
                step = .pickBusiness
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func discoverAccounts() async {
        guard let biz = selectedBusiness else { return }
        guard let token = KeychainService.shared.retrieve(
            forKey: KeychainService.Keys.waveAccessToken
        ) else { return }

        do {
            async let expenseFetch  = WaveAPIService.shared.fetchExpenseAccounts(
                businessId: biz.id, token: token
            )
            async let anchorFetch   = WaveAPIService.shared.fetchAnchorAccounts(
                businessId: biz.id, token: token
            )
            async let taxFetch      = WaveAPIService.shared.fetchSalesTaxes(
                businessId: biz.id, token: token
            )

            expenseAccounts = try await expenseFetch
            anchorAccounts  = try await anchorFetch
            salesTaxes      = try await taxFetch

            // Auto-select HST if found
            selectedSalesTax = salesTaxes.first {
                $0.name.uppercased().contains("HST")
            } ?? salesTaxes.first

            // Default to first accounts
            selectedExpenseAccount = expenseAccounts.first
            selectedAnchorAccount  = anchorAccounts.first

            step = .configureAccounts
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func finishSetup() {
        guard let biz = selectedBusiness,
              let expense = selectedExpenseAccount,
              let anchor = selectedAnchorAccount
        else { return }

        settings.waveBusinessId        = biz.id
        settings.waveBusinessName      = biz.name
        settings.waveExpenseAccountId  = expense.id
        settings.waveAnchorAccountId   = anchor.id
        settings.waveSalesTaxId        = selectedSalesTax?.id ?? ""
        settings.hasWaveToken          = true

        // Request notification permission for upload alerts
        NotificationService.shared.requestPermission()

        onComplete()
    }

    private func skipSetup() {
        settings.hasWaveToken = false
        onComplete()
    }
}

// MARK: - Hashable conformance for Picker binding

extension WaveAccount: Hashable {
    static func == (lhs: WaveAccount, rhs: WaveAccount) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

extension WaveSalesTax: Hashable {
    static func == (lhs: WaveSalesTax, rhs: WaveSalesTax) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}
