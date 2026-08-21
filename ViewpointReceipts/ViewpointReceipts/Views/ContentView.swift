import SwiftUI

/// Root view — gates on onboarding completion, with a multi-step wizard.
struct ContentView: View {

    @Environment(AppSettings.self) private var settings
    @State private var onboardingStep = 0

    var body: some View {
        Group {
            if settings.hasCompletedOnboarding {
                ReceiptListView()
            } else {
                onboardingFlow
            }
        }
        .animation(.default, value: settings.hasCompletedOnboarding)
        .animation(.default, value: onboardingStep)
    }

    @ViewBuilder
    private var onboardingFlow: some View {
        switch onboardingStep {
        case 0:
            StorageChoiceView {
                onboardingStep = 1
            }
        case 1:
            APIKeySetupView {
                onboardingStep = 2
            }
        default:
            WaveSetupView {
                settings.hasCompletedOnboarding = true
            }
        }
    }
}
