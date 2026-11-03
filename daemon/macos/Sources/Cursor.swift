import AppKit

// The cursor goes to the viewer apart from the video, as on the other hosts:
// its position in points across the captured area, and its image when it
// changes. macOS has no cursor events for other apps, so it's polled.

final class CursorWatcher {
    private let source: Source
    private let conn: Conn
    private var timer: DispatchSourceTimer?
    private var imageGen: UInt64 = 0, posGen: UInt64 = 0
    private var sentImageGen: UInt64 = 0
    private var image = (rgba: Data(), width: 0, height: 0, hotX: 0, hotY: 0)
    private var pos = (x: Int.min, y: Int.min, inside: false)
    private var rect: CGRect
    private var ticks = 0

    init(source: Source, conn: Conn) {
        self.source = source
        self.conn = conn
        rect = source.rect
    }

    func start() {
        let t = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "cursor"))
        t.schedule(deadline: .now(), repeating: .milliseconds(16))
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }

    func stop() { timer?.cancel() }

    private func tick() {
        ticks += 1
        var changed = false
        // The image and a moving window, ten times a second.
        if ticks % 6 == 1 {
            if source.window != nil {
                rect = source.current()
            }
            if let img = currentImage(), img.rgba != image.rgba || img.hotX != image.hotX || img.hotY != image.hotY {
                image = img
                imageGen += 1
                changed = true
            }
        }
        guard let at = CGEvent(source: nil)?.location else { return }
        let x = Int((at.x - rect.minX).rounded(.down)), y = Int((at.y - rect.minY).rounded(.down))
        let inside = rect.contains(at)
        if x != pos.x || y != pos.y || inside != pos.inside {
            pos = (x, y, inside)
            posGen += 1
            changed = true
        }
        if changed {
            send()
        }
    }

    private func send() {
        var p = Data(capacity: IPC.cursorHeaderLen)
        p.appendLE(imageGen)
        p.appendLE(posGen)
        p.append(pos.inside ? 1 : 0)
        for v in [pos.x, pos.y, image.hotX, image.hotY, image.width, image.height] {
            p.appendLE(Int32(clamping: v))
        }
        var pixels = Data()
        if imageGen != sentImageGen {
            pixels = image.rgba
            sentImageGen = imageGen
        }
        if !conn.write(IPC.msgCursor, p, pixels) {
            stop()
        }
    }

    /// currentImage renders the system cursor at its size in points, RGBA.
    private func currentImage() -> (rgba: Data, width: Int, height: Int, hotX: Int, hotY: Int)? {
        onMain {
            guard let c = NSCursor.currentSystem else { return nil }
            let size = c.image.size
            let w = min(Int(size.width.rounded()), 128), h = min(Int(size.height.rounded()), 128)
            guard w > 0, h > 0, let cg = c.image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
            var data = Data(count: w * h * 4)
            let ok = data.withUnsafeMutableBytes { p -> Bool in
                guard let ctx = CGContext(data: p.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                          space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
                else { return false }
                ctx.interpolationQuality = .high
                ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
                return true
            }
            guard ok else { return nil }
            unpremultiply(&data)
            return (data, w, h, Int(c.hotSpot.x.rounded()), Int(c.hotSpot.y.rounded()))
        }
    }
}

/// unpremultiply turns premultiplied RGBA into straight RGBA, as the viewer
/// draws it.
func unpremultiply(_ data: inout Data) {
    data.withUnsafeMutableBytes { p in
        let b = p.bindMemory(to: UInt8.self)
        var i = 0
        while i + 3 < b.count {
            let a = Int(b[i + 3])
            if a > 0 && a < 255 {
                for j in 0..<3 {
                    b[i + j] = UInt8(min(255, Int(b[i + j]) * 255 / a))
                }
            }
            i += 4
        }
    }
}
