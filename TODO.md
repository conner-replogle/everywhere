# TODO

## Desktop app

- [ ] **Sign and notarize the macOS build.** Until then the Mac app is ad-hoc signed: macOS warns on
  first open and Squirrel.Mac won't install updates. On the MacBook (paid Developer Program, team
  `4VLGT28337`; it only has an Apple Development cert now):
  - Xcode → Settings → Accounts → Manage Certificates → + → **Developer ID Application**.
  - Export it as a .p12 and set `MAC_CERTIFICATE_P12_BASE64` (base64 of the .p12) and
    `MAC_CERTIFICATE_PASSWORD`.
  - Notarization: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (appleid.apple.com) and `APPLE_TEAM_ID`;
    or an App Store Connect API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`), which
    isn't tied to an Apple ID password but needs release.yml to pass those instead.
  - Cut a tag and check `codesign -dv` shows the Developer ID and `spctl -a -v` accepts it; then
    copies installed before it (ad-hoc) need one manual reinstall.

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
