import AppKit
import ApplicationServices
import CoreGraphics

// Everywhere Desktop is the daemon's remote desktop helper on macOS: an app
// of its own, so Screen Recording and Accessibility are granted to it and not
// to the daemon. The daemon launches it through LaunchServices (`open -n`)
// and it connects back to the Unix socket in its arguments:
//
//	worker <socket> <config JSON>  capture, encode and inject input (ipc.Config)
//	host <socket>                  answer the daemon's questions about the desktop
//	setup                          ask for its permissions, once, on the Mac
//
// It is never run by hand.

signal(SIGPIPE, SIG_IGN)
setvbuf(stderr, nil, _IOLBF, 0)

func log(_ s: String) {
    FileHandle.standardError.write(("everywhere-desktop[\(getpid())]: " + s + "\n").data(using: .utf8)!)
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    print("Everywhere Desktop is started by the everywhere daemon for remote desktop sessions.")
    exit(2)
}

switch args[1] {
case "version":
    print(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev")
    exit(0)
case "setup":
    // Shows macOS's prompts for both permissions, which add the app to their
    // lists in System Settings.
    if !CGPreflightScreenCaptureAccess() {
        _ = CGRequestScreenCaptureAccess()
    }
    _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary)
    exit(0)
case "worker", "host":
    break
default:
    log("unknown mode \(args[1])")
    exit(2)
}

guard args.count >= 3, let conn = try? Conn(path: args[2]) else {
    log("can't connect to the daemon")
    exit(1)
}

func fail(_ msg: String) -> Never {
    conn.write(IPC.msgError, Data(msg.utf8))
    exit(1)
}

let mode = args[1]
Thread.detachNewThread {
    if mode == "host" {
        runHost(conn)
    } else {
        guard args.count >= 4, let cfg = try? JSONDecoder().decode(IPC.Config.self, from: Data(args[3].utf8)) else {
            fail("desktop worker: bad config")
        }
        if cfg.agent {
            runAgent(cfg, conn)
        } else {
            runWorker(cfg, conn)
        }
    }
    exit(0)
}
// AppKit (screens, the cursor, the clipboard) runs on the main thread.
NSApplication.shared.setActivationPolicy(.prohibited)
dispatchMain()

/// openInput opens input injection, or says why the session is view-only.
@Sendable func openInput(_ cfg: IPC.Config, output: String) -> (Injector?, String?) {
    guard cfg.input else { return (nil, nil) }
    do {
        return (try Injector(output: output), nil)
    } catch {
        log("input unavailable; session is view-only: \(error)")
        return (nil, "\(error)")
    }
}

func apply(_ inj: Injector?, _ cmd: UInt8, _ p: Data) {
    guard let inj else { return }
    switch cmd {
    case IPC.cmdMotion:
        inj.motion(p.readLE(UInt16.self, at: 0), p.readLE(UInt16.self, at: 2))
    case IPC.cmdMotionBy:
        inj.motionBy(Double(Float(bitPattern: p.readLE(UInt32.self, at: 0))), Double(Float(bitPattern: p.readLE(UInt32.self, at: 4))))
    case IPC.cmdButtonHere:
        inj.button(p.readLE(UInt32.self, at: 0), p[p.startIndex + 4] != 0)
    case IPC.cmdButton:
        inj.motion(p.readLE(UInt16.self, at: 5), p.readLE(UInt16.self, at: 7))
        inj.button(p.readLE(UInt32.self, at: 0), p[p.startIndex + 4] != 0)
    case IPC.cmdScroll:
        inj.scroll(continuous: p[p.startIndex] != 0, Double(bitPattern: p.readLE(UInt64.self, at: 1)), Double(bitPattern: p.readLE(UInt64.self, at: 9)))
    case IPC.cmdKey:
        inj.key(p.readLE(UInt32.self, at: 0), p[p.startIndex + 4] != 0)
    case IPC.cmdReleaseAll:
        inj.releaseAll()
    default:
        break
    }
}

func runWorker(_ cfg: IPC.Config, _ conn: Conn) {
    let src: Source
    let cap: Capture
    do {
        src = try Source.find(output: cfg.output, window: cfg.window)
        cap = try Capture(cfg: cfg, source: src, conn: conn)
    } catch {
        fail("\(error)")
    }
    let stopped = DispatchSemaphore(value: 0)
    var stopError: String?
    cap.onStop = { msg in
        stopError = msg
        stopped.signal()
    }
    do {
        try cap.start()
    } catch {
        fail("\(error)")
    }
    let (inj, inputError) = openInput(cfg, output: src.display.name)
    conn.write(IPC.msgHello, IPC.hello(width: src.pixelWidth, height: src.pixelHeight, output: src.display.name, inputError: inputError))
    cap.goLive()

    var cursor: CursorWatcher?
    if !cfg.paintCursor {
        cursor = CursorWatcher(source: src, conn: conn)
        cursor?.start()
    }
    Thread.detachNewThread {
        while let (cmd, p) = conn.readCommand(), cmd != IPC.cmdQuit {
            switch cmd {
            case IPC.cmdKeyframe: cap.requestKeyframe()
            case IPC.cmdBitrate: cap.setBitrate(Int(p.readLE(UInt32.self, at: 0)))
            default: apply(inj, cmd, p)
            }
        }
        stopped.signal()
    }
    stopped.wait()
    cursor?.stop()
    inj?.releaseAll()
    cap.stop()
    if let msg = stopError {
        fail(msg)
    }
}

/// runAgent serves an agent's tools: screenshots when asked, and input.
func runAgent(_ cfg: IPC.Config, _ conn: Conn) {
    let output = (try? findDisplay(cfg.output))?.name ?? cfg.output
    let (inj, inputError) = openInput(cfg, output: output)
    conn.write(IPC.msgHello, IPC.hello(output: output, inputError: inputError))
    while let (cmd, p) = conn.readCommand(), cmd != IPC.cmdQuit {
        switch cmd {
        case IPC.cmdStill:
            do {
                let shot = try screenshot(try Source.find(output: cfg.output, window: cfg.window))
                var hdr = Data([1])
                hdr.appendLE(UInt32(shot.width))
                hdr.appendLE(UInt32(shot.height))
                conn.write(IPC.msgStill, hdr, shot.rgba)
            } catch {
                conn.write(IPC.msgStill, Data([0]), Data("\(error)".utf8))
            }
        case IPC.cmdType:
            if let inj {
                inj.type(p.readLE(UInt32.self, at: 0))
                conn.write(IPC.msgTyped, Data([0]))
            } else {
                conn.write(IPC.msgTyped, Data([1]))
            }
        case IPC.cmdKeyframe, IPC.cmdBitrate:
            break
        default:
            apply(inj, cmd, p)
        }
    }
    inj?.releaseAll()
}
