import Foundation

// The pipe protocol of internal/desktop/ipc, over the Unix socket the daemon
// passes in argv. Messages to the daemon are a type byte, a little-endian u32
// length and the payload; commands from it are a command byte and a
// fixed-size payload (worker), or framed like messages (host).
enum IPC {
    /// ipc.Version: the daemon refuses a helper from another revision.
    static let version = 3

    // Worker → daemon.
    static let msgHello = UInt8(ascii: "H")
    static let msgFrame = UInt8(ascii: "F")
    static let msgCursor = UInt8(ascii: "C")
    static let msgError = UInt8(ascii: "E")
    static let msgStill = UInt8(ascii: "I")
    static let msgTyped = UInt8(ascii: "T")
    // Host → daemon.
    static let msgReply = UInt8(ascii: "A")
    static let msgEvent = UInt8(ascii: "V")
    // Daemon → host.
    static let msgRequest = UInt8(ascii: "Q")

    // Daemon → worker.
    static let cmdKeyframe = UInt8(ascii: "K")
    static let cmdBitrate = UInt8(ascii: "B")
    static let cmdQuit = UInt8(ascii: "Q")
    static let cmdMotion = UInt8(ascii: "M")
    static let cmdButton = UInt8(ascii: "P")
    static let cmdScroll = UInt8(ascii: "S")
    static let cmdKey = UInt8(ascii: "Y")
    static let cmdReleaseAll = UInt8(ascii: "R")
    static let cmdMotionBy = UInt8(ascii: "m")
    static let cmdButtonHere = UInt8(ascii: "p")
    static let cmdStill = UInt8(ascii: "G")
    static let cmdType = UInt8(ascii: "T")

    static let commandLen: [UInt8: Int] = [
        cmdKeyframe: 0, cmdBitrate: 4, cmdQuit: 0, cmdMotion: 4, cmdButton: 9,
        cmdScroll: 17, cmdKey: 5, cmdReleaseAll: 0, cmdStill: 0, cmdType: 4, cmdMotionBy: 8, cmdButtonHere: 5,
    ]

    static let cursorHeaderLen = 41
    static let maxMessage = 64 << 20

    enum Codec: Int, Decodable { case h264 = 0, h265 = 1, av1 = 2 }

    /// ipc.Config.
    struct Config: Decodable {
        var output = ""
        var window = ""
        var bitrateKbps = 0
        var paintCursor = false
        var targetUsage = 4
        var codec = Codec.h264
        var width = 0, height = 0
        var maxFPS = 0
        var input = false
        var agent = false

        enum CodingKeys: String, CodingKey {
            case output = "Output", window = "Window", bitrateKbps = "BitrateKbps", paintCursor = "PaintCursor"
            case targetUsage = "TargetUsage", codec = "Codec", width = "Width", height = "Height"
            case maxFPS = "MaxFPS", input = "Input", agent = "Agent"
        }

        init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            output = try c.decodeIfPresent(String.self, forKey: .output) ?? ""
            window = try c.decodeIfPresent(String.self, forKey: .window) ?? ""
            bitrateKbps = try c.decodeIfPresent(Int.self, forKey: .bitrateKbps) ?? 0
            paintCursor = try c.decodeIfPresent(Bool.self, forKey: .paintCursor) ?? false
            targetUsage = try c.decodeIfPresent(Int.self, forKey: .targetUsage) ?? 4
            codec = try c.decodeIfPresent(Codec.self, forKey: .codec) ?? .h264
            width = try c.decodeIfPresent(Int.self, forKey: .width) ?? 0
            height = try c.decodeIfPresent(Int.self, forKey: .height) ?? 0
            maxFPS = try c.decodeIfPresent(Int.self, forKey: .maxFPS) ?? 0
            input = try c.decodeIfPresent(Bool.self, forKey: .input) ?? false
            agent = try c.decodeIfPresent(Bool.self, forKey: .agent) ?? false
        }
    }

    /// ipc.Hello.
    static func hello(width: Int = 0, height: Int = 0, output: String, inputError: String? = nil) -> Data {
        var h: [String: Any] = ["Version": version, "Width": width, "Height": height, "Output": output]
        if let e = inputError { h["InputError"] = e }
        return try! JSONSerialization.data(withJSONObject: h)
    }
}

extension Data {
    mutating func appendLE<T: FixedWidthInteger>(_ v: T) {
        Swift.withUnsafeBytes(of: v.littleEndian) { append(contentsOf: $0) }
    }

    func readLE<T: FixedWidthInteger>(_: T.Type, at offset: Int) -> T {
        var v = T.zero
        Swift.withUnsafeMutableBytes(of: &v) { dst in
            self.withUnsafeBytes { src in
                dst.copyMemory(from: UnsafeRawBufferPointer(rebasing: src[(src.startIndex + offset)..<(src.startIndex + offset + MemoryLayout<T>.size)]))
            }
        }
        return T(littleEndian: v)
    }
}

/// Conn is the connection to the daemon: framed writes from any thread,
/// buffered reads from one.
final class Conn: @unchecked Sendable { // writes take writeLock; one thread reads
    private let fd: Int32
    private let writeLock = NSLock()
    private var buf = [UInt8](repeating: 0, count: 1 << 16)
    private var start = 0, end = 0

    init(path: String) throws {
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw HelperError("socket: \(String(cString: strerror(errno)))") }
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let ok = withUnsafeMutableBytes(of: &addr.sun_path) { p -> Bool in
            let bytes = Array(path.utf8)
            guard bytes.count < p.count else { return false }
            p.copyBytes(from: bytes)
            return true
        }
        guard ok else { throw HelperError("socket path too long") }
        let r = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard r == 0 else { throw HelperError("connect \(path): \(String(cString: strerror(errno)))") }
    }

    /// write sends one message; false once the daemon is gone.
    @discardableResult
    func write(_ type: UInt8, _ parts: Data...) -> Bool {
        var msg = Data([type])
        msg.appendLE(UInt32(parts.reduce(0) { $0 + $1.count }))
        for p in parts { msg.append(p) }
        writeLock.lock()
        defer { writeLock.unlock() }
        return msg.withUnsafeBytes { p in
            var off = 0
            while off < p.count {
                let n = Darwin.write(fd, p.baseAddress! + off, p.count - off)
                if n < 0 && errno == EINTR { continue }
                if n <= 0 { return false }
                off += n
            }
            return true
        }
    }

    /// read fills exactly n bytes; nil at end of stream.
    func read(_ n: Int) -> Data? {
        var out = Data(capacity: n)
        while out.count < n {
            if start == end {
                let r = buf.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress!, $0.count) }
                if r < 0 && errno == EINTR { continue }
                if r <= 0 { return nil }
                start = 0
                end = r
            }
            let take = min(n - out.count, end - start)
            out.append(contentsOf: buf[start..<(start + take)])
            start += take
        }
        return out
    }

    /// readMessage reads one framed message (host mode).
    func readMessage() -> (UInt8, Data)? {
        guard let hdr = read(5) else { return nil }
        let n = Int(hdr.readLE(UInt32.self, at: 1))
        guard n <= IPC.maxMessage, let payload = read(n) else { return nil }
        return (hdr[hdr.startIndex], payload)
    }

    /// readCommand reads one fixed-size command (worker mode); nil at the
    /// end of the stream or on an unknown command.
    func readCommand() -> (UInt8, Data)? {
        guard let c = read(1), let n = IPC.commandLen[c[c.startIndex]] else { return nil }
        guard let p = read(n) else { return nil }
        return (c[c.startIndex], p)
    }
}

struct HelperError: Error, CustomStringConvertible {
    let description: String
    init(_ s: String) { description = s }
}

/// onMain runs f on the main thread, which AppKit wants.
func onMain<T>(_ f: () -> T) -> T {
    Thread.isMainThread ? f() : DispatchQueue.main.sync(execute: f)
}

/// blocking runs an async call from synchronous code.
func blocking<T>(_ f: @escaping () async throws -> T) throws -> T {
    let sem = DispatchSemaphore(value: 0)
    var result: Result<T, Error>!
    Task.detached {
        do { result = .success(try await f()) } catch { result = .failure(error) }
        sem.signal()
    }
    sem.wait()
    return try result.get()
}
