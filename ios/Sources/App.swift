import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    // The canvas holds an evidence journal, and the app switcher would
    // otherwise thumbnail it. Android sets FLAG_SECURE; here a shield covers
    // the window whenever the app leaves the foreground.
    private let shield = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = ViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        guard let window, shield.superview == nil else { return }
        shield.frame = window.bounds
        shield.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        window.addSubview(shield)
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        shield.removeFromSuperview()
    }
}
