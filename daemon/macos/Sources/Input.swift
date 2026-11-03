import AppKit
import CoreGraphics

// Input goes through CGEvent, into the session's one pointer and keyboard
// focus. Keys come as Linux evdev codes, as everywhere in remote desktop, and
// are pressed by position: the Mac's own layout decides the character, as it
// does for a physical key. Linux's Super is ⌘, Alt is ⌥.

final class Injector: @unchecked Sendable { // its state is under lock
    private let display: Display
    private let source = CGEventSource(stateID: .hidSystemState)
    private let lock = NSLock()

    private var keys = Set<UInt32>()
    private var buttons = Set<UInt32>()
    private var flags = CGEventFlags()
    private var capsLock = false
    private var rest = CGPoint.zero // MotionBy's fractions of a point, carried over
    private var scrollRest = CGPoint.zero
    private var lastClick = (button: UInt32(0), at: Date.distantPast, point: CGPoint.zero, count: 0)

    init(output: String) throws {
        guard AXIsProcessTrusted() else { throw HelperError(accessibilityOff) }
        display = try findDisplay(output)
    }

    private var location: CGPoint {
        CGEvent(source: nil)?.location ?? CGPoint(x: display.bounds.midX, y: display.bounds.midY)
    }

    /// motion moves the pointer to x, y in 0..65535 across the display.
    func motion(_ x: UInt16, _ y: UInt16) {
        let b = display.bounds
        let p = CGPoint(x: b.minX + Double(x) / 65535 * (b.width - 1), y: b.minY + Double(y) / 65535 * (b.height - 1))
        lock.withLock { move(to: p, delta: CGPoint(x: p.x - location.x, y: p.y - location.y)) }
    }

    /// motionBy moves the pointer by dx, dy display pixels, as a mouse does.
    func motionBy(_ dx: Double, _ dy: Double) {
        lock.withLock {
            let s = display.scale
            let d = CGPoint(x: rest.x + dx / s, y: rest.y + dy / s)
            let id = CGPoint(x: d.x.rounded(.towardZero), y: d.y.rounded(.towardZero))
            rest = CGPoint(x: d.x - id.x, y: d.y - id.y)
            if id == .zero { return }
            let b = display.bounds
            let at = location
            let p = CGPoint(x: min(max(at.x + id.x, b.minX), b.maxX - 1), y: min(max(at.y + id.y, b.minY), b.maxY - 1))
            move(to: p, delta: id)
        }
    }

    // Must hold lock.
    private func move(to p: CGPoint, delta: CGPoint) {
        let (type, button): (CGEventType, CGMouseButton) =
            if buttons.contains(btnLeft) { (.leftMouseDragged, .left) }
            else if buttons.contains(btnRight) { (.rightMouseDragged, .right) }
            else if !buttons.isEmpty { (.otherMouseDragged, .center) }
            else { (.mouseMoved, .left) }
        guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return }
        e.setIntegerValueField(.mouseEventDeltaX, value: Int64(delta.x))
        e.setIntegerValueField(.mouseEventDeltaY, value: Int64(delta.y))
        post(e)
    }

    /// button presses or releases a Linux BTN_* button where the pointer is.
    func button(_ code: UInt32, _ pressed: Bool) {
        lock.withLock {
            let mapped: (CGMouseButton, CGEventType, CGEventType)
            switch code {
            case btnLeft: mapped = (.left, .leftMouseDown, .leftMouseUp)
            case btnRight: mapped = (.right, .rightMouseDown, .rightMouseUp)
            case btnMiddle: mapped = (.center, .otherMouseDown, .otherMouseUp)
            case btnSide: mapped = (CGMouseButton(rawValue: 3)!, .otherMouseDown, .otherMouseUp)
            case btnExtra: mapped = (CGMouseButton(rawValue: 4)!, .otherMouseDown, .otherMouseUp)
            default: return
            }
            if pressed == buttons.contains(code) { return }
            let at = location
            if pressed {
                buttons.insert(code)
                // macOS counts clicks itself only for real devices.
                let near = abs(at.x - lastClick.point.x) <= 4 && abs(at.y - lastClick.point.y) <= 4
                let quick = Date().timeIntervalSince(lastClick.at) <= onMain({ NSEvent.doubleClickInterval })
                let count = lastClick.button == code && near && quick ? lastClick.count + 1 : 1
                lastClick = (code, Date(), at, count)
            } else {
                buttons.remove(code)
            }
            guard let e = CGEvent(mouseEventSource: source, mouseType: pressed ? mapped.1 : mapped.2, mouseCursorPosition: at, mouseButton: mapped.0) else { return }
            e.setIntegerValueField(.mouseEventClickState, value: Int64(lastClick.count))
            if mapped.0.rawValue >= 2 {
                e.setIntegerValueField(.mouseEventButtonNumber, value: Int64(mapped.0.rawValue))
            }
            post(e)
        }
    }

    /// scroll sends pixel deltas when continuous, otherwise wheel notches;
    /// positive dy scrolls down, dx right.
    func scroll(continuous: Bool, _ dx: Double, _ dy: Double) {
        lock.withLock {
            // A wheel notch is three lines, as on the other hosts.
            let k = continuous ? 1.0 : 3.0
            let d = CGPoint(x: scrollRest.x - dx * k, y: scrollRest.y - dy * k)
            let id = CGPoint(x: d.x.rounded(.towardZero), y: d.y.rounded(.towardZero))
            scrollRest = CGPoint(x: d.x - id.x, y: d.y - id.y)
            if id == .zero { return }
            guard let e = CGEvent(scrollWheelEvent2Source: source, units: continuous ? .pixel : .line, wheelCount: 2,
                                  wheel1: Int32(id.y), wheel2: Int32(id.x), wheel3: 0) else { return }
            e.setIntegerValueField(.scrollWheelEventIsContinuous, value: continuous ? 1 : 0)
            post(e)
        }
    }

    /// key presses or releases a key by its Linux KEY_* code.
    func key(_ code: UInt32, _ pressed: Bool) {
        lock.withLock {
            guard let vk = macKeys[code] else { return } // no such key on a Mac
            if pressed == keys.contains(code) && code != keyCapsLock { return }
            if pressed { keys.insert(code) } else { keys.remove(code) }
            if let mask = modifierMasks[code] {
                if code == keyCapsLock {
                    if !pressed { return }
                    capsLock.toggle()
                }
                updateFlags(mask)
                guard let e = CGEvent(keyboardEventSource: source, virtualKey: vk, keyDown: pressed) else { return }
                e.type = .flagsChanged
                post(e)
                return
            }
            guard let e = CGEvent(keyboardEventSource: source, virtualKey: vk, keyDown: pressed) else { return }
            if numericPad.contains(code) {
                e.flags.insert(.maskNumericPad)
            }
            post(e)
        }
    }

    // Must hold lock.
    private func updateFlags(_ mask: CGEventFlags) {
        let held = keys.contains { modifierMasks[$0] == mask && $0 != keyCapsLock }
        if mask == .maskAlphaShift ? capsLock : held { flags.insert(mask) } else { flags.remove(mask) }
    }

    /// type types one character, whatever the layout.
    func type(_ r: UInt32) {
        lock.withLock {
            switch r {
            case 0x0A, 0x0D: tap(0x24) // return
            case 0x09: tap(0x30) // tab
            default:
                guard let s = Unicode.Scalar(r) else { return }
                let utf16 = Array(String(Character(s)).utf16)
                for down in [true, false] {
                    guard let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { return }
                    e.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
                    e.flags = []
                    e.post(tap: .cghidEventTap)
                }
            }
        }
    }

    // Must hold lock.
    private func tap(_ vk: CGKeyCode) {
        for down in [true, false] {
            if let e = CGEvent(keyboardEventSource: source, virtualKey: vk, keyDown: down) {
                post(e)
            }
        }
    }

    /// releaseAll releases every key and button this injector pressed.
    func releaseAll() {
        let (k, b) = lock.withLock { (keys, buttons) }
        for code in b { button(code, false) }
        for code in k where code != keyCapsLock { key(code, false) }
    }

    // Must hold lock.
    private func post(_ e: CGEvent) {
        if e.type != .flagsChanged {
            e.flags = e.flags.union(flags)
        } else {
            e.flags = flags
        }
        e.post(tap: .cghidEventTap)
    }
}

// Linux BTN_* codes.
let btnLeft: UInt32 = 0x110, btnRight: UInt32 = 0x111, btnMiddle: UInt32 = 0x112
let btnSide: UInt32 = 0x113, btnExtra: UInt32 = 0x114

let keyCapsLock: UInt32 = 58

let modifierMasks: [UInt32: CGEventFlags] = [
    29: .maskControl, 97: .maskControl, // LEFTCTRL RIGHTCTRL
    42: .maskShift, 54: .maskShift, // LEFTSHIFT RIGHTSHIFT
    56: .maskAlternate, 100: .maskAlternate, // LEFTALT RIGHTALT
    125: .maskCommand, 126: .maskCommand, // LEFTMETA RIGHTMETA
    58: .maskAlphaShift, // CAPSLOCK
]

let numericPad: Set<UInt32> = [55, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 96, 98, 117, 69]

// Linux KEY_* code → macOS virtual key code (kVK_*).
let macKeys: [UInt32: CGKeyCode] = [
    1: 0x35, // ESC
    2: 0x12, 3: 0x13, 4: 0x14, 5: 0x15, 6: 0x17, 7: 0x16, 8: 0x1A, 9: 0x1C, 10: 0x19, 11: 0x1D, // 1..0
    12: 0x1B, 13: 0x18, 14: 0x33, 15: 0x30, // MINUS EQUAL BACKSPACE TAB
    16: 0x0C, 17: 0x0D, 18: 0x0E, 19: 0x0F, 20: 0x11, 21: 0x10, 22: 0x20, 23: 0x22, 24: 0x1F, 25: 0x23, // Q..P
    26: 0x21, 27: 0x1E, 28: 0x24, 29: 0x3B, // [ ] ENTER LEFTCTRL
    30: 0x00, 31: 0x01, 32: 0x02, 33: 0x03, 34: 0x05, 35: 0x04, 36: 0x26, 37: 0x28, 38: 0x25, // A..L
    39: 0x29, 40: 0x27, 41: 0x32, 42: 0x38, 43: 0x2A, // ; ' ` LEFTSHIFT BACKSLASH
    44: 0x06, 45: 0x07, 46: 0x08, 47: 0x09, 48: 0x0B, 49: 0x2D, 50: 0x2E, // Z..M
    51: 0x2B, 52: 0x2F, 53: 0x2C, 54: 0x3C, 55: 0x43, 56: 0x3A, 57: 0x31, 58: 0x39, // , . / RIGHTSHIFT KP* LEFTALT SPACE CAPSLOCK
    59: 0x7A, 60: 0x78, 61: 0x63, 62: 0x76, 63: 0x60, 64: 0x61, 65: 0x62, 66: 0x64, 67: 0x65, 68: 0x6D, // F1..F10
    69: 0x47, // NUMLOCK: the Mac keypad's Clear, in its place
    71: 0x59, 72: 0x5B, 73: 0x5C, 74: 0x4E, 75: 0x56, 76: 0x57, 77: 0x58, 78: 0x45, // KP7 KP8 KP9 KP- KP4 KP5 KP6 KP+
    79: 0x53, 80: 0x54, 81: 0x55, 82: 0x52, 83: 0x41, // KP1 KP2 KP3 KP0 KP.
    86: 0x0A, 87: 0x67, 88: 0x6F, // 102ND (ISO §) F11 F12
    89: 0x5E, 96: 0x4C, 97: 0x3E, 98: 0x4B, 100: 0x3D, // RO KPENTER RIGHTCTRL KP/ RIGHTALT
    102: 0x73, 103: 0x7E, 104: 0x74, 105: 0x7B, 106: 0x7C, 107: 0x77, 108: 0x7D, 109: 0x79, // HOME UP PGUP LEFT RIGHT END DOWN PGDN
    110: 0x72, 111: 0x75, // INSERT (Help) DELETE
    113: 0x4A, 114: 0x49, 115: 0x48, 117: 0x51, // MUTE VOLUMEDOWN VOLUMEUP KPEQUAL
    121: 0x5F, 122: 0x68, 123: 0x66, 124: 0x5D, // KPCOMMA HANGEUL (Kana) HANJA (Eisu) YEN
    125: 0x37, 126: 0x36, 127: 0x6E, // LEFTMETA RIGHTMETA COMPOSE (menu)
    183: 0x69, 184: 0x6B, 185: 0x71, 186: 0x6A, 187: 0x40, 188: 0x4F, 189: 0x50, 190: 0x5A, // F13..F20
]
