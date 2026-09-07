import WebKit

// Serves the bundled web app on magpie://localhost the way the Android
// wrapper's WebViewAssetLoader serves it on appassets.androidplatform.net:
// every byte the page loads comes out of the app bundle.
//
// The host string is load-bearing twice over. WebKit's secure-context check
// trusts any origin whose host is literally "localhost" regardless of scheme,
// and that trust is what turns on crypto.subtle for this page (Capacitor
// ships capacitor://localhost for the same reason). And scheme+host is the
// storage origin: change either and every user's saved journal is silently
// orphaned. magpie://localhost is permanent.
//
// iOS has no permission that takes the network away from an app. What
// enforces "loads nothing remote" here is the meta Content-Security-Policy
// the page itself ships (headers on a WKURLSchemeTask response are not
// reliably enforced; the meta tag in index.html is, on every platform).
final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "magpie"
    static let host = "localhost"
    static let start = URL(string: "\(scheme)://\(host)/index.html")!

    private static let mime: [String: String] = [
        "html": "text/html; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "json": "application/json",
        "webmanifest": "application/manifest+json",
        "svg": "image/svg+xml",
        "png": "image/png",
        "ico": "image/x-icon",
        "txt": "text/plain; charset=utf-8",
        "xml": "application/xml",
        "woff2": "font/woff2",
        "wasm": "application/wasm",
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        // A non-nil port would put the page on a distinct (scheme, host,
        // port) origin with its own empty storage: reject it rather than
        // silently serving a second, storage-orphaned copy of the app.
        guard let url = task.request.url, url.host == Self.host, url.port == nil,
              let base = Bundle.main.resourceURL?
                  .appendingPathComponent("app", isDirectory: true)
                  .standardizedFileURL
        else {
            task.didFailWithError(URLError(.unsupportedURL))
            return
        }
        var rel = url.path
        if rel.isEmpty || rel == "/" { rel = "/index.html" }
        let file = base.appendingPathComponent(String(rel.dropFirst())).standardizedFileURL
        // Resolve symlinks before the containment check, on both sides: a
        // crafted path that resolves outside the bundled app directory (or
        // a base that is itself reached through a link) dies here instead
        // of reading the app container.
        let resolvedBase = base.resolvingSymlinksInPath().path
        let resolvedFile = file.resolvingSymlinksInPath().path
        guard resolvedFile.hasPrefix(resolvedBase + "/"),
              let data = try? Data(contentsOf: file)
        else {
            respond(task, url: url, status: 404, mime: "text/plain; charset=utf-8", data: Data("not found".utf8))
            return
        }
        let ext = file.pathExtension.lowercased()
        respond(task, url: url, status: 200, mime: Self.mime[ext] ?? "application/octet-stream", data: data)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func respond(_ task: WKURLSchemeTask, url: URL, status: Int, mime: String, data: Data) {
        let headers = [
            "Content-Type": mime,
            "Content-Length": String(data.count),
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
        ]
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
            task.didFailWithError(URLError(.badServerResponse))
            return
        }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }
}
