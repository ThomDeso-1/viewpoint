import SwiftUI
import SwiftData

@main
struct ViewpointReceiptsApp: App {

    private let settings: AppSettings
    private let storageService: StorageService
    private let uploadService: UploadService
    private let healthCheckService: HealthCheckService

    init() {
        let s = AppSettings()
        self.settings = s
        self.storageService = StorageService(settings: s)
        self.uploadService = UploadService(settings: s)
        self.healthCheckService = HealthCheckService(settings: s)
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(settings)
                .environment(storageService)
                .environment(uploadService)
                .environment(healthCheckService)
        }
        .modelContainer(for: Receipt.self)
    }
}
