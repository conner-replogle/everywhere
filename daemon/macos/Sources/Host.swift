import AppKit

// Host mode answers the daemon's questions about the desktop, one JSON
// request at a time ({"op": ...} → {"result": ...} or {"error": ...}), and
// tells it when the clipboard changes ({"event": "clipboard"}). The daemon
// keeps one running while it uses the desktop.

func runHost(_ conn: Conn) {
    var h = (try? JSONSerialization.jsonObject(with: IPC.hello(output: ""))) as? [String: Any] ?? [:]
    h["ScreenRecording"] = CGPreflightScreenCaptureAccess()
    h["Accessibility"] = AXIsProcessTrusted()
    conn.write(IPC.msgHello, try! JSONSerialization.data(withJSONObject: h))

    let watch = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "clipboard"))
    var count = clipboardChangeCount()
    watch.schedule(deadline: .now() + .milliseconds(250), repeating: .milliseconds(250))
    watch.setEventHandler {
        let c = clipboardChangeCount()
        if c != count {
            count = c
            conn.write(IPC.msgEvent, try! JSONSerialization.data(withJSONObject: ["event": "clipboard"]))
        }
    }
    watch.resume()

    while let (typ, payload) = conn.readMessage() {
        guard typ == IPC.msgRequest,
              let req = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any],
              let op = req["op"] as? String
        else { continue }
        var reply: [String: Any]
        do {
            reply = ["result": try handle(op, req)]
        } catch {
            reply = ["error": "\(error)"]
        }
        conn.write(IPC.msgReply, (try? JSONSerialization.data(withJSONObject: reply)) ?? Data("{}".utf8))
    }
    watch.cancel()
}

private func handle(_ op: String, _ req: [String: Any]) throws -> Any {
    switch op {
    case "monitors":
        let ds = displays()
        let focused = focusedDisplay(ds)
        return ds.enumerated().map { i, d -> [String: Any] in
            [
                "id": i, "name": d.name, "width": d.pixelWidth, "height": d.pixelHeight,
                "x": Int(d.bounds.minX), "y": Int(d.bounds.minY), "scale": d.scale, "focused": i == focused,
            ]
        }
    case "windows":
        let ds = displays()
        let all = windows()
        return [
            "windows": all.map { w -> [String: Any] in
                let id = String(w.id)
                return [
                    "address": id, "stableId": id, "mapped": true, "hidden": !w.onScreen,
                    "at": [Int(w.bounds.minX), Int(w.bounds.minY)], "size": [Int(w.bounds.width), Int(w.bounds.height)],
                    "monitor": displayIndex(w.bounds, ds), "class": w.app, "title": w.title, "pid": Int(w.pid),
                ]
            },
            "active": activeWindow(all).map { String($0.id) } ?? "",
        ]
    case "focus":
        guard let s = req["id"] as? String, let id = CGWindowID(s) else { throw HelperError("bad window id") }
        try focus(id)
        return true
    case "clipboard":
        if let text = readClipboard() {
            return ["text": text, "ok": true]
        }
        return ["ok": false]
    case "setClipboard":
        writeClipboard(req["text"] as? String ?? "")
        return true
    case "permissions":
        return ["screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()]
    default:
        throw HelperError("unknown op \(op)")
    }
}

/// focusedDisplay is the display with the frontmost window, else the one
/// with the pointer.
private func focusedDisplay(_ ds: [Display]) -> Int {
    if let w = activeWindow(windows()) {
        return displayIndex(w.bounds, ds)
    }
    if let at = CGEvent(source: nil)?.location, let i = ds.firstIndex(where: { $0.bounds.contains(at) }) {
        return i
    }
    return 0
}
