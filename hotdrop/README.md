# HotDrop

Move files between your Android phone and your Windows PC over the phone's own
hotspot. No cables, no accounts, no internet, no pairing codes.

| | |
|---|---|
| **Windows** | [`dist/HotDrop.exe`](dist/HotDrop.exe): one file, no install (Windows 10/11) |
| **Android** | [`dist/HotDrop.apk`](dist/HotDrop.apk): Android 8.0+ |

## Using it

1. Turn on **Hotspot** on your phone and open **HotDrop** there.
2. Connect your PC's **Wi-Fi** to the phone's hotspot.
3. Double-click **HotDrop.exe**. It finds the phone by itself within a couple of seconds.

Then:

- **PC → phone:** drag files (or whole folders) onto the HotDrop window, or click it to choose.
  They land in **Download/HotDrop** on the phone. Tap a received file to open it.
- **Phone → PC:** tap **Photos & videos** or **Files**, or use **Share → HotDrop** from
  any app (Gallery, Files, WhatsApp, …). They land in **Downloads\HotDrop** on the PC.
  Click a received file to show it in Explorer.

You can queue files before the other side is connected; they start sending
the moment it shows up. Closing the PC window quits the app. On the phone, use
**Stop** in the notification.

If the PC can't find the phone (rare: some networks block device-to-device
traffic), type the address shown on the phone's screen into the PC window.

## Why it's fast

- Files stream straight from disk to the network in 1 MB chunks, with no
  compression, no encryption overhead and no temp copies. The PC streams
  dropped files directly to the phone without saving them first.
- Up to 3 files transfer in parallel in each direction, which keeps the Wi-Fi
  link full when sending many small photos.
- The phone holds a wake lock only while a transfer is running, so the screen
  can turn off without slowing anything down.

Real-world speed is set by the hotspot's Wi-Fi link. On a 5 GHz hotspot
(phone hotspot settings → AP band → 5 GHz) expect roughly 20–60 MB/s; on
2.4 GHz, a few MB/s.

## How it works

```
 phone (hotspot, 192.168.x.1)                 PC (on the hotspot)
 ┌──────────────────────────┐   HTTP :47820  ┌────────────────────────────┐
 │ tiny HTTP server         │ ◀──────────────│ HotDrop.exe                │
 │  GET  /ping              │   PC always    │  • scans its /24 for :47820│
 │  GET  /outbox (long-poll)│   connects     │  • pushes dropped files    │
 │  GET  /file/{id}         │                │  • pulls queued files      │
 │  PUT  /upload            │                │  • UI on 127.0.0.1:47830   │
 └──────────────────────────┘                └────────────────────────────┘
```

The PC only ever makes outgoing connections, so **Windows Firewall never
prompts** and nothing needs configuring. The PC UI is a local page shown in an
Edge app window (Chrome or the default browser as fallback). It is only
reachable from the PC itself.

Security model: anyone who knows your hotspot password could reach the phone's
transfer port while the app is running, the same trust you already place in
devices on your hotspot. Stop the app when you're not using it.

## Building

Windows exe (cross-compiles from any OS, Go 1.22+):

```sh
cd windows
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -H=windowsgui" -o ../dist/HotDrop.exe .
```

Android APK (JDK 17+, Android SDK with platform 35):

```sh
cd android
./gradlew assembleRelease   # → app/build/outputs/apk/release/app-release.apk
```

The release APK is signed with the build machine's debug key so it installs
directly. A build from a different machine has a different key, so uninstall
the old app before installing it.

Tests: `cd windows && go test ./...` (subnet scan, file naming).
