# TODO

## Remote desktop: later

- [ ] **macOS remote desktop.** A signed `Everywhere Desktop.app` (Swift), run as its own LaunchAgent so
  TCC grants attach to it and not to the daemon. It speaks the same worker IPC over a 0700 Unix socket.
  - Capture: ScreenCaptureKit (`SCContentFilter(display:)`; windows via `desktopIndependentWindow:`),
    NV12, `queueDepth` 3.
  - Encode: VideoToolbox low-latency rate control, `RealTime`, no frame reordering, forced keyframes.
  - Input: `CGEventPost` (Accessibility). Clipboard: `NSPasteboard`. Audio: `SCStream capturesAudio`.
  - Spaces have no public API: previous/next Space and Mission Control buttons send the system shortcuts.
  - Needs launchd support in the daemon and installer, and `everywhere update` fetching the app.
  - Decide on Developer ID signing + notarization, and apply for the
    `com.apple.developer.persistent-content-capture` entitlement. Without it, macOS 15+ re-consent
    alerts appear on a Mac nobody is sitting at.
- [ ] Audio (PipeWire → Opus), phone/tablet touch input (trackpad mode, soft keyboard).
- [ ] Several viewers at once (one controller, "Take over") instead of the newest viewer taking over.
- [ ] Bitrate cap on TURN-relayed paths; ICE restart and TURN credential refresh for long sessions.
- [ ] Window thumbnails in the source picker; "All monitors" view; images on the clipboard.
- [ ] GNOME/KDE via the portal (ScreenCast + RemoteDesktop/libei), set up once locally.
