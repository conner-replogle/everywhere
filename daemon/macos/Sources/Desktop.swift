import AppKit
import ApplicationServices
import CoreGraphics

// The desktop as the daemon sees it, in Hyprland's terms: monitors with a
// position in points (global, top-left origin), a size in pixels and a scale;
// windows with a position and size in points.

struct Display {
    let id: CGDirectDisplayID
    let name: String
    let bounds: CGRect // points, global top-left coordinates
    let pixelWidth: Int, pixelHeight: Int
    var scale: Double { Double(pixelWidth) / Double(bounds.width) }
}

/// displays lists the active displays, the main one (with the menu bar) first.
func displays() -> [Display] {
    var n: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &n) == .success, n > 0 else { return [] }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(n))
    guard CGGetActiveDisplayList(n, &ids, &n) == .success else { return [] }
    ids = Array(ids.prefix(Int(n)))
    let main = CGMainDisplayID()
    ids.sort { a, b in a == main && b != main }

    let names: [CGDirectDisplayID: String] = onMain {
        var m: [CGDirectDisplayID: String] = [:]
        for s in NSScreen.screens {
            if let id = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID {
                m[id] = s.localizedName
            }
        }
        return m
    }
    var seen: [String: Int] = [:]
    return ids.map { id in
        // Names tell monitors apart, so a second identical display gets a number.
        var name = names[id] ?? "Display \(id)"
        seen[name, default: 0] += 1
        if seen[name]! > 1 { name += " (\(seen[name]!))" }
        let bounds = CGDisplayBounds(id)
        var pw = Int(bounds.width), ph = Int(bounds.height)
        if let mode = CGDisplayCopyDisplayMode(id) {
            pw = mode.pixelWidth
            ph = mode.pixelHeight
        }
        return Display(id: id, name: name, bounds: bounds, pixelWidth: pw, pixelHeight: ph)
    }
}

/// findDisplay finds a display by name; "" is the main display.
func findDisplay(_ name: String) throws -> Display {
    let all = displays()
    if let d = name.isEmpty ? all.first : all.first(where: { $0.name == name }) {
        return d
    }
    throw HelperError("no display named \(name)")
}

struct Window {
    let id: CGWindowID
    let pid: pid_t
    let app: String
    let title: String
    let bounds: CGRect // points
    let onScreen: Bool
}

/// windows lists the apps' windows, frontmost first: those on screen, then
/// titled ones that aren't (minimized, or in another Space).
func windows() -> [Window] {
    guard let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    let me = getpid()
    var out: [Window] = []
    for w in list {
        guard (w[kCGWindowLayer as String] as? Int) == 0,
              let id = w[kCGWindowNumber as String] as? CGWindowID,
              let pid = w[kCGWindowOwnerPID as String] as? pid_t, pid != me,
              let b = w[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: b),
              bounds.width >= 50, bounds.height >= 50
        else { continue }
        let alpha = w[kCGWindowAlpha as String] as? Double ?? 1
        let onScreen = (w[kCGWindowIsOnscreen as String] as? Bool ?? false) && alpha > 0
        let title = w[kCGWindowName as String] as? String ?? ""
        if !onScreen && title.isEmpty { continue }
        let app = w[kCGWindowOwnerName as String] as? String ?? ""
        if app == "Window Server" || app == "Dock" { continue }
        out.append(Window(id: id, pid: pid, app: app, title: title, bounds: bounds, onScreen: onScreen))
    }
    return out.filter { $0.onScreen } + out.filter { !$0.onScreen }
}

func findWindow(_ id: CGWindowID) -> Window? {
    windows().first { $0.id == id }
}

/// activeWindow is the frontmost app's frontmost window.
func activeWindow(_ all: [Window]) -> Window? {
    guard let pid = onMain({ NSWorkspace.shared.frontmostApplication?.processIdentifier }) else { return nil }
    return all.first { $0.pid == pid && $0.onScreen }
}

/// displayIndex is the index of the display showing most of rect.
func displayIndex(_ rect: CGRect, _ ds: [Display]) -> Int {
    var best = -1
    var bestArea: CGFloat = 0
    for (i, d) in ds.enumerated() {
        let r = d.bounds.intersection(rect)
        if !r.isNull && r.width * r.height > bestArea {
            best = i
            bestArea = r.width * r.height
        }
    }
    if best < 0 {
        let c = CGPoint(x: rect.midX, y: rect.midY)
        best = ds.firstIndex { $0.bounds.contains(c) } ?? 0
    }
    return best
}

@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

/// axWindow is a window's accessibility element.
func axWindow(_ w: Window) -> AXUIElement? {
    let app = AXUIElementCreateApplication(w.pid)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
          let list = value as? [AXUIElement]
    else { return nil }
    for el in list {
        var id: CGWindowID = 0
        if _AXUIElementGetWindow(el, &id) == .success && id == w.id {
            return el
        }
    }
    return nil
}

/// focus brings a window to the front with keyboard focus, restoring it if
/// it's minimized; macOS switches to its Space.
func focus(_ id: CGWindowID) throws {
    guard let w = findWindow(id) else { throw HelperError("no window \(id)") }
    guard AXIsProcessTrusted() else { throw HelperError(accessibilityOff) }
    let app = AXUIElementCreateApplication(w.pid)
    if let el = axWindow(w) {
        AXUIElementSetAttributeValue(el, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
        AXUIElementSetAttributeValue(el, kAXMainAttribute as CFString, kCFBooleanTrue)
        AXUIElementPerformAction(el, kAXRaiseAction as CFString)
    }
    AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    _ = onMain { NSRunningApplication(processIdentifier: w.pid)?.activate() }
}

let screenRecordingOff = "Screen Recording is off for Everywhere Desktop: on the Mac, allow it in System Settings › Privacy & Security › Screen & System Audio Recording"
let accessibilityOff = "Accessibility is off for Everywhere Desktop, so it can't control the Mac: allow it in System Settings › Privacy & Security › Accessibility"

// The clipboard (text).

func readClipboard() -> String? {
    onMain { NSPasteboard.general.string(forType: .string) }
}

func writeClipboard(_ text: String) {
    onMain {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

func clipboardChangeCount() -> Int {
    onMain { NSPasteboard.general.changeCount }
}
