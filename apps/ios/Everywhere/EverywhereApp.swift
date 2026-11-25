// Everywhere for iOS: the web app in a native shell, as apps/desktop is on the
// desktop. The page is always the server's own (so it's never out of date);
// the shell adds what a home-screen web app can't do: links that leave the app
// open in Safari, downloads go to the share sheet, JavaScript dialogs work, and
// the page knows it's in the app (window.everywhereIOS).

import SwiftUI

@main
struct EverywhereApp: App {
    @StateObject private var server = ServerStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(server)
                .preferredColorScheme(.dark)
        }
    }
}

extension Color {
    /// The web app's background (#222222), so nothing flashes white.
    static let appBackground = Color(red: 0x22 / 255, green: 0x22 / 255, blue: 0x22 / 255)
}

extension UIColor {
    static let appBackground = UIColor(red: 0x22 / 255, green: 0x22 / 255, blue: 0x22 / 255, alpha: 1)
}

struct RootView: View {
    @EnvironmentObject private var server: ServerStore

    var body: some View {
        ZStack {
            Color.appBackground.ignoresSafeArea()
            if let url = server.url {
                BrowserScreen(url: url).id(url)
            } else {
                ServerView()
            }
        }
    }
}

/// The app's page, with a spinner while it first loads and a way out when it can't.
struct BrowserScreen: View {
    @EnvironmentObject private var server: ServerStore
    @StateObject private var web: WebController

    init(url: URL) {
        _web = StateObject(wrappedValue: WebController(url: url))
    }

    var body: some View {
        ZStack {
            WebView(webView: web.webView)
                .ignoresSafeArea()
                .opacity(web.loaded ? 1 : 0)
            if let error = web.error {
                LoadErrorView(host: web.origin.host ?? web.origin.absoluteString, message: error) {
                    web.retry()
                } changeServer: {
                    server.url = nil
                }
            } else if !web.loaded {
                ProgressView().tint(.secondary)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .everywhereChangeServer)) { _ in
            server.url = nil
        }
    }
}

struct LoadErrorView: View {
    let host: String
    let message: String
    let retry: () -> Void
    let changeServer: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            Text("Can't reach \(host)")
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Try again", action: retry)
                .buttonStyle(.borderedProminent)
                .padding(.top, 6)
            Button("Change server", action: changeServer)
                .font(.subheadline)
        }
        .padding(32)
        .frame(maxWidth: 420)
    }
}
