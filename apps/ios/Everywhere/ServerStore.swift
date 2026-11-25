import SwiftUI

/// Which Everywhere server the app shows. Self-hosted, so the user names it the
/// first time (ai.replogle.dev is offered, as the desktop app's default).
final class ServerStore: ObservableObject {
    static let defaultURL = "https://ai.replogle.dev"
    private static let key = "serverURL"
    private static let lastKey = "lastServerURL"

    /// The server to show; nil until one is chosen, or while choosing another.
    @Published var url: URL? {
        didSet {
            UserDefaults.standard.set(url?.absoluteString, forKey: Self.key)
            if let url { UserDefaults.standard.set(url.absoluteString, forKey: Self.lastKey) }
        }
    }

    /// The last server used, to offer again when changing it.
    var lastURL: String {
        UserDefaults.standard.string(forKey: Self.lastKey) ?? Self.defaultURL
    }

    init() {
        url = UserDefaults.standard.string(forKey: Self.key).flatMap(URL.init(string:))
    }

    /// The server's origin from what was typed: "example.com" means https://example.com.
    static func normalize(_ text: String) -> URL? {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if !s.contains("://") { s = "https://" + s }
        guard let parsed = URLComponents(string: s),
              let scheme = parsed.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = parsed.host, !host.isEmpty
        else { return nil }
        var origin = URLComponents()
        origin.scheme = scheme
        origin.host = host.lowercased()
        origin.port = parsed.port
        origin.path = "/"
        return origin.url
    }
}

/// First run (and "Change server"): which server to connect to.
struct ServerView: View {
    @EnvironmentObject private var server: ServerStore
    @State private var text = ""
    @State private var checking = false
    @State private var message: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Spacer()
            Logo().frame(width: 64, height: 64)
            Text("everywhere")
                .font(.system(size: 34, weight: .semibold, design: .rounded))
            Text("The address of your Everywhere server.")
                .foregroundStyle(.secondary)
            TextField("everywhere.example.com", text: $text)
                .textContentType(.URL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .focused($focused)
                .onSubmit(connect)
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.08)))
            if let message {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            Button(action: connect) {
                HStack(spacing: 8) {
                    if checking { ProgressView().tint(.ink) }
                    Text(checking ? "Connecting…" : "Connect")
                }
                .foregroundStyle(Color.ink)
                .fontWeight(.semibold)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .disabled(checking || text.trimmingCharacters(in: .whitespaces).isEmpty)
            Spacer()
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: 480)
        .onAppear { if text.isEmpty { text = server.lastURL } }
    }

    private func connect() {
        guard let url = ServerStore.normalize(text) else {
            message = "That isn't a web address."
            return
        }
        checking = true
        message = nil
        focused = false
        Task { @MainActor in
            defer { checking = false }
            do {
                var req = URLRequest(url: url.appendingPathComponent("api/auth/me"))
                req.timeoutInterval = 15
                let (data, resp) = try await URLSession.shared.data(for: req)
                let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
                let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                guard status == 200, json?.keys.contains("user") == true else {
                    message = "\(url.host ?? "That") doesn't look like an Everywhere server."
                    return
                }
                server.url = url
            } catch {
                message = error.localizedDescription
            }
        }
    }
}

/// The app's mark: a prompt chevron and a dot (apps/web/public/favicon.svg).
struct Logo: View {
    var body: some View {
        GeometryReader { geo in
            let u = geo.size.width / 32
            ZStack {
                RoundedRectangle(cornerRadius: 7 * u, style: .continuous)
                    .fill(Color.ink)
                Path { p in
                    p.move(to: CGPoint(x: 8 * u, y: 11 * u))
                    p.addLine(to: CGPoint(x: 14 * u, y: 16 * u))
                    p.addLine(to: CGPoint(x: 8 * u, y: 21 * u))
                }
                .stroke(Color(red: 0x8f / 255, green: 0xa8 / 255, blue: 1),
                        style: StrokeStyle(lineWidth: 2.6 * u, lineCap: .round, lineJoin: .round))
                Circle()
                    .fill(Color(red: 0x5f / 255, green: 0xd4 / 255, blue: 0xa3 / 255))
                    .frame(width: 6 * u, height: 6 * u)
                    .position(x: 22.5 * u, y: 20.5 * u)
            }
        }
    }
}

extension Color {
    /// The logo's dark background, also the text on the accent color.
    static let ink = Color(red: 0x15 / 255, green: 0x18 / 255, blue: 0x1e / 255)
}
