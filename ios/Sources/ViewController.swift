import UIKit
import SafariServices
import WebKit

// One screen: the bundled web app in a WKWebView on the fixed custom-scheme
// origin. The wrapper ships no networking code of its own; what the page can
// load is bounded by the CSP the app's own index.html carries.
final class ViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var webView: WKWebView!

    // The app's own paper background (light/dark), from app/css/app.css's
    // --paper token, so the safe-area letterbox and the overscroll bounce
    // match the journal instead of the system's generic background.
    private static let appBackground = UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0x10 / 255.0, green: 0x14 / 255.0, blue: 0x13 / 255.0, alpha: 1)
            : UIColor(red: 0xee / 255.0, green: 0xf2 / 255.0, blue: 0xf0 / 255.0, alpha: 1)
    }

    // Exports handed across the JS bridge land here before the share sheet
    // picks one up. Wiped at every launch: nothing from a past export
    // should ever outlive its own hand-off.
    private static let exportsDir = FileManager.default.temporaryDirectory
        .appendingPathComponent("exports", isDirectory: true)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.appBackground
        Self.excludeWebKitDataFromBackup()
        try? FileManager.default.removeItem(at: Self.exportsDir)
        try? FileManager.default.createDirectory(at: Self.exportsDir, withIntermediateDirectories: true)

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(AppSchemeHandler(), forURLScheme: AppSchemeHandler.scheme)
        config.websiteDataStore = .default()
        // The export bridge: the page posts { name, mime, b64 } here and a
        // share sheet (including "Save to Files") opens in response. There
        // is no reply channel back to the page; the sheet's own outcome is
        // all the feedback a person needs, and platform.js treats the
        // hand-off itself, not a result from here, as success.
        config.userContentController.add(self, name: "save")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = Self.appBackground
        webView.allowsLinkPreview = false
        // The system text-size setting reaches web content the way Android's
        // textZoom does: scale the page by the user's Dynamic Type factor.
        webView.pageZoom = Self.dynamicTypeZoom()

        NotificationCenter.default.addObserver(
            self, selector: #selector(dynamicTypeChanged),
            name: UIContentSizeCategory.didChangeNotification, object: nil)

        // Pinned to the safe area: the page never hides under the notch or
        // the home indicator, and the letterbox matches the app's theme.
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
        ])

        webView.load(URLRequest(url: AppSchemeHandler.start))
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    private static func dynamicTypeZoom() -> CGFloat {
        UIFontMetrics(forTextStyle: .body).scaledValue(for: 17) / 17
    }

    @objc private func dynamicTypeChanged() {
        webView.pageZoom = Self.dynamicTypeZoom()
    }

    // The journal is real user data, and there is no toggle for it: unlike
    // Android's allowBackup="false", iOS backs up an app's container by
    // default. This directory is where WKWebsiteDataStore.default() keeps
    // IndexedDB, so marking it excluded is what keeps a device or iCloud
    // backup from silently becoming a second copy of the vault the threat
    // model promises does not exist. Safe to call every launch: creating an
    // empty placeholder before WebKit ever touches the directory works the
    // same as marking one WebKit already populated. Failure here is not
    // fatal (an unwritable container has bigger problems than a backup
    // flag), so it is swallowed rather than crashing the app over it; there
    // is nothing useful to log that isn't already implied by this comment.
    private static func excludeWebKitDataFromBackup() {
        guard let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first else { return }
        var dir = library.appendingPathComponent("WebKit", isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
    }

    // MARK: WKScriptMessageHandler (the export bridge)

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "save",
              let body = message.body as? [String: Any],
              let b64 = body["b64"] as? String,
              let data = Data(base64Encoded: b64)
        else { return }
        let name = sanitize((body["name"] as? String) ?? "export")
        let fileURL = Self.exportsDir.appendingPathComponent(name)
        guard (try? data.write(to: fileURL, options: .atomic)) != nil else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let sheet = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
            if let popover = sheet.popoverPresentationController {
                popover.sourceView = self.view
                popover.sourceRect = CGRect(x: self.view.bounds.midX, y: self.view.bounds.maxY, width: 0, height: 0)
            }
            self.present(sheet, animated: true)
        }
    }

    // A bare filename, nothing a path could climb out of the temp dir with.
    private func sanitize(_ name: String) -> String {
        let base = (name as NSString).lastPathComponent
        let safe = base.replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "_", options: .regularExpression)
        let trimmed = safe.trimmingCharacters(in: CharacterSet(charactersIn: "._"))
        return trimmed.isEmpty ? "export.zip" : String(safe.prefix(80))
    }

    // The web view only ever navigates inside the bundle; a link out goes to
    // the system's browser view. Gated hard: main-frame https navigations
    // from a real link tap, nothing else.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if url.scheme == AppSchemeHandler.scheme {
            decisionHandler(.allow)
            return
        }
        if url.scheme == "https",
           navigationAction.targetFrame?.isMainFrame != false,
           navigationAction.navigationType == .linkActivated {
            present(SFSafariViewController(url: url), animated: true)
        }
        decisionHandler(.cancel)
    }

    // window.open / target=_blank from the page: same rule, no new web view,
    // and only for a real link tap (a script calling window.open on its own
    // gets nothing, the same as any other synthetic navigation here).
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url, url.scheme == "https",
           navigationAction.navigationType == .linkActivated {
            present(SFSafariViewController(url: url), animated: true)
        }
        return nil
    }
}
