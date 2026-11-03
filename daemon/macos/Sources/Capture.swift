import AppKit
import CoreMedia
import ScreenCaptureKit
import VideoToolbox

// A capture streams one display, or one window, with ScreenCaptureKit into
// NV12 surfaces, and encodes them with VideoToolbox: low-latency rate
// control, no frame reordering, parameter sets on every keyframe, Annex B
// out. ScreenCaptureKit only delivers frames when something changed, so a
// keyframe request re-encodes the last one.

/// Source is what a capture shows: a display, or a window on it.
struct Source {
    let display: Display
    let filter: SCContentFilter
    let window: CGWindowID?
    /// rect is the captured area in points (global, top-left origin).
    var rect: CGRect
    var pixelWidth: Int { Int((rect.width * display.scale).rounded()) & ~1 }
    var pixelHeight: Int { Int((rect.height * display.scale).rounded()) & ~1 }

    static func find(output: String, window: String) throws -> Source {
        guard CGPreflightScreenCaptureAccess() else { throw HelperError(screenRecordingOff) }
        let content: SCShareableContent
        do {
            content = try blocking { try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) }
        } catch {
            throw HelperError("\(screenRecordingOff) (\(error.localizedDescription))")
        }
        if !window.isEmpty {
            guard let id = CGWindowID(window), let w = content.windows.first(where: { $0.windowID == id }) else {
                throw HelperError("no window \(window)")
            }
            let ds = displays()
            let i = displayIndex(w.frame, ds)
            guard i >= 0, i < ds.count else { throw HelperError("the window isn't on a display") }
            return Source(display: ds[i], filter: SCContentFilter(desktopIndependentWindow: w), window: id, rect: w.frame)
        }
        let d = try findDisplay(output)
        guard let sc = content.displays.first(where: { $0.displayID == d.id }) else {
            throw HelperError("no display named \(output)")
        }
        return Source(display: d, filter: SCContentFilter(display: sc, excludingWindows: []), window: nil, rect: d.bounds)
    }

    /// current is the captured area now: a window moves.
    func current() -> CGRect {
        guard let id = window,
              let list = CGWindowListCreateDescriptionFromArray([NSNumber(value: id)] as CFArray) as? [[String: Any]],
              let b = list.first?[kCGWindowBounds as String] as? NSDictionary,
              let r = CGRect(dictionaryRepresentation: b)
        else { return rect }
        return r
    }
}

final class Capture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable { // its state is on queue
    let source: Source
    private let conn: Conn
    private let cfg: IPC.Config
    private let queue = DispatchQueue(label: "capture", qos: .userInteractive)
    private var stream: SCStream?
    private var session: VTCompressionSession?
    private var lastFrame: CVImageBuffer? // for keyframe requests while nothing changes
    private var forceKeyframe = true
    private var lastPTS = CMTime.negativeInfinity
    private var live = false // frames wait for the daemon to have the Hello
    private let liveLock = NSLock()
    private var bitrateKbps: Int
    private let width: Int, height: Int
    var onStop: ((String?) -> Void)?

    init(cfg: IPC.Config, source: Source, conn: Conn) throws {
        self.cfg = cfg
        self.source = source
        self.conn = conn
        bitrateKbps = max(cfg.bitrateKbps, 500)
        width = cfg.width > 0 ? cfg.width : source.pixelWidth
        height = cfg.height > 0 ? cfg.height : source.pixelHeight
        super.init()
        try makeEncoder()
    }

    func start() throws {
        let sc = SCStreamConfiguration()
        sc.width = width
        sc.height = height
        sc.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        sc.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
        sc.colorSpaceName = CGColorSpace.sRGB
        sc.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(cfg.maxFPS > 0 ? cfg.maxFPS : 60))
        sc.queueDepth = 4 // one is kept for keyframe requests
        sc.showsCursor = cfg.paintCursor
        sc.scalesToFit = true
        if source.window != nil {
            sc.ignoreShadowsSingleWindow = true
        }
        let stream = SCStream(filter: source.filter, configuration: sc, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        do {
            try blocking { try await stream.startCapture() }
        } catch {
            throw HelperError("starting the capture: \(error.localizedDescription)")
        }
        self.stream = stream
    }

    func stop() {
        if let s = stream {
            try? blocking { try await s.stopCapture() }
        }
        queue.sync {
            if let s = session {
                VTCompressionSessionCompleteFrames(s, untilPresentationTimeStamp: .invalid)
                VTCompressionSessionInvalidate(s)
            }
            session = nil
            lastFrame = nil
        }
    }

    private func makeEncoder() throws {
        let hevc = cfg.codec == .h265
        let spec = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true] as CFDictionary
        var s: VTCompressionSession?
        var st = VTCompressionSessionCreate(allocator: nil, width: Int32(width), height: Int32(height),
                                            codecType: hevc ? kCMVideoCodecType_HEVC : kCMVideoCodecType_H264,
                                            encoderSpecification: spec, imageBufferAttributes: nil, compressedDataAllocator: nil,
                                            outputCallback: nil, refcon: nil, compressionSessionOut: &s)
        if st != noErr {
            // Not every encoder has low-latency rate control.
            st = VTCompressionSessionCreate(allocator: nil, width: Int32(width), height: Int32(height),
                                            codecType: hevc ? kCMVideoCodecType_HEVC : kCMVideoCodecType_H264,
                                            encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil,
                                            outputCallback: nil, refcon: nil, compressionSessionOut: &s)
        }
        guard st == noErr, let s else { throw HelperError("no \(hevc ? "HEVC" : "H.264") encoder (VideoToolbox error \(st))") }
        let props: [CFString: Any] = [
            kVTCompressionPropertyKey_RealTime: true,
            kVTCompressionPropertyKey_AllowFrameReordering: false,
            kVTCompressionPropertyKey_ProfileLevel: hevc ? kVTProfileLevel_HEVC_Main_AutoLevel : kVTProfileLevel_H264_High_AutoLevel,
            kVTCompressionPropertyKey_MaxKeyFrameInterval: 60 * 60 * 10,
            kVTCompressionPropertyKey_ExpectedFrameRate: cfg.maxFPS > 0 ? cfg.maxFPS : 60,
            kVTCompressionPropertyKey_AverageBitRate: bitrateKbps * 1000,
            kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality: cfg.targetUsage >= 6,
            kVTCompressionPropertyKey_ColorPrimaries: kCVImageBufferColorPrimaries_ITU_R_709_2,
            kVTCompressionPropertyKey_TransferFunction: kCVImageBufferTransferFunction_ITU_R_709_2,
            kVTCompressionPropertyKey_YCbCrMatrix: kCVImageBufferYCbCrMatrix_ITU_R_709_2,
        ]
        for (k, v) in props {
            VTSessionSetProperty(s, key: k, value: v as CFTypeRef)
        }
        VTCompressionSessionPrepareToEncodeFrames(s)
        session = s
    }

    /// goLive sends frames from now on, starting with a keyframe.
    func goLive() {
        liveLock.withLock { live = true }
        requestKeyframe()
    }

    func requestKeyframe() {
        queue.async {
            self.forceKeyframe = true
            if let f = self.lastFrame {
                self.encode(f, at: CMClockGetTime(CMClockGetHostTimeClock()))
            }
        }
    }

    func setBitrate(_ kbps: Int) {
        queue.async {
            self.bitrateKbps = kbps
            if let s = self.session {
                VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AverageBitRate, value: kbps * 1000 as CFNumber)
            }
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sb.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
              let img = CMSampleBufferGetImageBuffer(sb)
        else { return }
        lastFrame = img
        encode(img, at: CMSampleBufferGetPresentationTimeStamp(sb))
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let msg = source.window != nil ? "the window closed" : "the capture stopped: \(error.localizedDescription)"
        onStop?(msg)
    }

    // On queue.
    private func encode(_ img: CVImageBuffer, at t: CMTime) {
        guard let s = session else { return }
        // A re-encoded frame is stamped now, so a later capture can be older.
        var pts = t
        if pts <= lastPTS {
            pts = lastPTS + CMTime(value: 1, timescale: 1000)
        }
        lastPTS = pts
        var props: CFDictionary?
        if forceKeyframe {
            forceKeyframe = false
            props = [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary
        }
        VTCompressionSessionEncodeFrame(s, imageBuffer: img, presentationTimeStamp: pts, duration: .invalid,
                                        frameProperties: props, infoFlagsOut: nil) { [weak self] status, _, sb in
            guard status == noErr, let sb, let self else { return }
            self.send(sb, pts: pts)
        }
    }

    private func send(_ sb: CMSampleBuffer, pts: CMTime) {
        guard liveLock.withLock({ live }) else { return }
        guard let data = annexB(sb, hevc: cfg.codec == .h265) else { return }
        var hdr = Data()
        hdr.appendLE(UInt64(max(0, pts.seconds) * 1_000_000))
        hdr.append(data.keyframe ? 1 : 0)
        if !conn.write(IPC.msgFrame, hdr, data.bytes) {
            onStop?(nil)
        }
    }
}

/// annexB turns an encoded sample (length-prefixed NAL units) into an Annex B
/// access unit, with the parameter sets in front of a keyframe.
func annexB(_ sb: CMSampleBuffer, hevc: Bool) -> (bytes: Data, keyframe: Bool)? {
    guard let block = CMSampleBufferGetDataBuffer(sb) else { return nil }
    let startCode: [UInt8] = [0, 0, 0, 1]
    var keyframe = true
    if let att = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]],
       let notSync = att.first?[kCMSampleAttachmentKey_NotSync] as? Bool {
        keyframe = !notSync
    }
    var out = Data()
    if keyframe, let fmt = CMSampleBufferGetFormatDescription(sb) {
        var count = 0
        if hevc {
            CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(fmt, parameterSetIndex: 0, parameterSetPointerOut: nil,
                                                               parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
        } else {
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 0, parameterSetPointerOut: nil,
                                                               parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
        }
        for i in 0..<count {
            var p: UnsafePointer<UInt8>?
            var n = 0
            let st = hevc
                ? CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(fmt, parameterSetIndex: i, parameterSetPointerOut: &p,
                                                                     parameterSetSizeOut: &n, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
                : CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: i, parameterSetPointerOut: &p,
                                                                     parameterSetSizeOut: &n, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
            if st == noErr, let p {
                out.append(contentsOf: startCode)
                out.append(p, count: n)
            }
        }
    }
    var length = 0
    var ptr: UnsafeMutablePointer<CChar>?
    guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &ptr) == noErr,
          let ptr
    else { return nil }
    let bytes = UnsafeRawPointer(ptr)
    var off = 0
    while off + 4 <= length {
        let n = Int(UInt32(bigEndian: bytes.loadUnaligned(fromByteOffset: off, as: UInt32.self)))
        off += 4
        guard n > 0, off + n <= length else { break }
        out.append(contentsOf: startCode)
        out.append(bytes.advanced(by: off).assumingMemoryBound(to: UInt8.self), count: n)
        off += n
    }
    return (out, keyframe)
}

/// screenshot takes one picture of the source at its full size, as RGBA.
func screenshot(_ src: Source) throws -> (width: Int, height: Int, rgba: Data) {
    let sc = SCStreamConfiguration()
    sc.width = src.pixelWidth
    sc.height = src.pixelHeight
    sc.showsCursor = true
    sc.scalesToFit = true
    if src.window != nil {
        sc.ignoreShadowsSingleWindow = true
    }
    let img: CGImage
    do {
        img = try blocking { try await SCScreenshotManager.captureImage(contentFilter: src.filter, configuration: sc) }
    } catch {
        throw HelperError("screenshot: \(error.localizedDescription)")
    }
    let w = img.width, h = img.height
    var data = Data(count: w * h * 4)
    let ok = data.withUnsafeMutableBytes { p -> Bool in
        guard let ctx = CGContext(data: p.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
        else { return false }
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        return true
    }
    guard ok else { throw HelperError("screenshot: can't convert the image") }
    return (w, h, data)
}
