# Everywhere for iOS

The web app in a native shell, as `apps/desktop` is on the desktop. The page
always comes from your server, so it's never out of date. The shell adds:

- **Server choice** on first launch (and from the error screen, or from the
  page with `window.everywhereIOS.changeServer()`).
- **Links that leave the app** open in Safari (or Mail, Phone…); the app only
  shows the server's own pages. Frames load anything.
- **Downloads** go to the share sheet.
- **`alert` / `confirm` / `prompt`**, which WKWebView drops unless the app shows them.
- **`window.everywhereIOS`** (`{ version, platform, changeServer() }`) and
  `EverywhereIOS/<version>` in the user agent, so the page knows it's in the app.
- The sign-in kept between launches, inline video for remote desktop, and a
  reload if iOS reclaims the page in the background. The page can be debugged
  from Safari → Develop.

Push notifications don't work yet: WKWebView has no Web Push, so the app
needs APNs.

## Building

Needs Xcode 16 or later (the project uses folder-synchronized groups, so new
files in `Everywhere/` are picked up without editing the project).

```sh
open apps/ios/Everywhere.xcodeproj        # then Run
# or
xcodebuild -project apps/ios/Everywhere.xcodeproj -scheme Everywhere \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build build
```

To run it on a phone, pick your team under Signing & Capabilities.
