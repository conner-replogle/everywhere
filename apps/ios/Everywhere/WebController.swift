import SwiftUI
import WebKit

extension Notification.Name {
    /// The page asked to pick another server (window.everywhereIOS.changeServer()).
    static let everywhereChangeServer = Notification.Name("everywhereChangeServer")
}

/// The WKWebView that shows the server's web app, and what the shell does for it.
final class WebController: NSObject, ObservableObject {
    let webView: WKWebView
    /// The server's origin: the only pages the app shows itself.
    let origin: URL
    /// Why the page couldn't load, while it can't.
    @Published var error: String?
    /// The page has loaded once (until then a spinner shows, not a blank page).
    @Published var loaded = false

    private var downloads: [ObjectIdentifier: URL] = [:]

    init(url: URL) {
        origin = url
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // keeps the sign-in between launches
        config.allowsInlineMediaPlayback = true // remote desktop video plays in the page
        config.mediaTypesRequiringUserActionForPlayback = []
        // Keep "Mobile/…" (the page's iOS checks look for it) and say it's the app.
        config.applicationNameForUserAgent = "Mobile/15E148 EverywhereIOS/\(version)"

        let bridge = """
        window.everywhereIOS = Object.freeze({
          version: \(Self.jsString(version)),
          platform: "ios",
          changeServer() { window.webkit.messageHandlers.everywhere.postMessage({ type: "changeServer" }); },
        });
        """
        config.userContentController.addUserScript(
            WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        webView = WKWebView(frame: .zero, configuration: config)
        super.init()

        config.userContentController.add(WeakMessageHandler(self), name: "everywhere")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = .appBackground
        webView.underPageBackgroundColor = .appBackground
        webView.scrollView.backgroundColor = .appBackground
        // The page lays itself out under the status bar and home indicator
        // (viewport-fit=cover and env(safe-area-inset-*)), as the installed PWA does.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.allowsBackForwardNavigationGestures = false
        webView.isInspectable = true // Safari → Develop, to debug the page

        webView.load(URLRequest(url: url))
    }

    deinit {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "everywhere")
    }

    func retry() {
        error = nil
        if webView.url == nil {
            webView.load(URLRequest(url: origin))
        } else {
            webView.reload()
        }
    }

    /// Whether a URL is the app's own (same scheme, host and port as the server).
    func isApp(_ url: URL) -> Bool {
        url.scheme?.lowercased() == origin.scheme && url.host?.lowercased() == origin.host
            && (url.port ?? Self.defaultPort(url.scheme)) == (origin.port ?? Self.defaultPort(origin.scheme))
    }

    private static func defaultPort(_ scheme: String?) -> Int? {
        switch scheme?.lowercased() {
        case "https": return 443
        case "http": return 80
        default: return nil
        }
    }

    private static func jsString(_ s: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [s])
        let array = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        return String(array.dropFirst().dropLast())
    }

    /// Hands a URL that isn't the app's to the system: Safari, Mail, Phone…
    private func openOutside(_ url: URL) {
        UIApplication.shared.open(url)
    }

    /// The view controller to present sheets and alerts from.
    private var presenter: UIViewController? {
        var vc = webView.window?.rootViewController
        while let next = vc?.presentedViewController { vc = next }
        return vc
    }
}

// MARK: - Navigation

extension WebController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.allow) }
        if action.shouldPerformDownload { return decisionHandler(.download) }
        switch url.scheme?.lowercased() {
        case "about", "blob", "data", "javascript":
            return decisionHandler(.allow)
        case "http", "https":
            // Frames (a dashboard, a preview) load what they like; the app
            // itself only ever shows the server's pages.
            let mainFrame = action.targetFrame?.isMainFrame ?? true
            if mainFrame && !isApp(url) {
                openOutside(url)
                return decisionHandler(.cancel)
            }
            return decisionHandler(.allow)
        default:
            // mailto:, tel:, other apps' links
            openOutside(url)
            return decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (response.response as? HTTPURLResponse)?
            .value(forHTTPHeaderField: "Content-Disposition")?.lowercased() ?? ""
        if !response.canShowMIMEType || disposition.hasPrefix("attachment") {
            return decisionHandler(.download)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        error = nil
        loaded = true
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    private func failed(_ error: Error) {
        let ns = error as NSError
        // Cancelled, or turned into a download / handed to another app: not a failure.
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        if ns.domain == "WebKitErrorDomain" && ns.code == 102 { return }
        // Only a page that never loaded needs the error screen; once it's up,
        // the web app shows its own reconnecting state.
        if !loaded || webView.url == nil { self.error = ns.localizedDescription }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // iOS reclaimed the page's memory while the app was in the background.
        webView.reload()
    }
}

// MARK: - New windows and JavaScript dialogs

extension WebController: WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // window.open and target=_blank: the app's own pages open here, others outside.
        if let url = action.request.url {
            if isApp(url) { webView.load(action.request) } else { openOutside(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard let presenter else { return completionHandler() }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        presenter.present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard let presenter else { return completionHandler(false) }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        presenter.present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        guard let presenter else { return completionHandler(nil) }
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
            completionHandler(alert.textFields?.first?.text ?? "")
        })
        presenter.present(alert, animated: true)
    }
}

// MARK: - Downloads: saved to a temporary folder, then offered in the share sheet

extension WebController: WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("Downloads", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            return completionHandler(nil)
        }
        let name = suggestedFilename.isEmpty ? "download" : suggestedFilename
        let file = dir.appendingPathComponent(name)
        downloads[ObjectIdentifier(download)] = file
        completionHandler(file)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)), let presenter else { return }
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, _, _, _ in
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
        }
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = webView
            popover.sourceRect = CGRect(x: webView.bounds.midX, y: webView.bounds.midY, width: 0, height: 0)
            popover.permittedArrowDirections = []
        }
        presenter.present(sheet, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        guard let presenter else { return }
        let alert = UIAlertController(title: "Download failed", message: error.localizedDescription,
                                      preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        presenter.present(alert, animated: true)
    }
}

// MARK: - Messages from the page

extension WebController: WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let origin = message.frameInfo.request.url, isApp(origin),
              let body = message.body as? [String: Any], let type = body["type"] as? String
        else { return }
        switch type {
        case "changeServer":
            NotificationCenter.default.post(name: .everywhereChangeServer, object: nil)
        default:
            break
        }
    }
}

/// WKUserContentController keeps its handlers alive; this keeps the controller from being one of them.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

/// Puts the controller's WKWebView in SwiftUI.
struct WebView: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
