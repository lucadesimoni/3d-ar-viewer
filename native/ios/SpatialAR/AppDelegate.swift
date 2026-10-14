import UIKit

/// The Spatial AR iOS shell: ARKit world tracking under the web app.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private let controller = ShellViewController()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
        controller.open(link: (launchOptions?[.url] as? URL)?.absoluteString)
        return true
    }

    /// `spatialar://open?url=…` while running: "Open in the Spatial AR app" from Safari.
    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        controller.open(link: url.absoluteString)
        return true
    }
}
