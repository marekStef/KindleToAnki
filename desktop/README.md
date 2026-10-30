# Kindle to Anki: desktop app (Windows & macOS)

Plug in your Kindle and the app finds `system/vocabulary/vocab.db` **on the device itself**,
copies it off, lists your books and builds Anki decks (`.apkg` + Markdown). You don't need
Amazon's USB helper, and you don't have to copy any files by hand.

It produces the same cards as the web app in `../server` (same front/back HTML, Cambridge
scrape, SMART vocabulary, optional LLM explanations), and its `.apkg` writer is a port of
`@steve2955/anki-apkg-export`, so a deck with the same name gets the same note GUIDs.

## How the file is taken off the Kindle

| | Kindle as a USB drive (older models) | Kindle over MTP (2022+ models, e.g. Paperwhite 12th gen) |
|---|---|---|
| **Windows** | read `X:\system\vocabulary\vocab.db` | Windows Shell portable-device API (the same thing Explorer uses), via a PowerShell script (`src/main/kindle/windows/kindle-shell.ps1`) |
| **macOS** | read `/Volumes/Kindle/system/vocabulary/vocab.db` | **built-in MTP client** over raw USB (`src/main/kindle/mtp/`), no Android File Transfer, OpenMTP or Send to Kindle |

macOS has no MTP support of its own. On top of that, its camera import daemon (`ptpcamerad`)
grabs MTP devices the moment they are plugged in, and that is the reason other apps need
Amazon's helper. When the Kindle is blocked, the app checks the IORegistry to see who holds it.
If it is the camera daemon, the app stops it and claims the device before macOS restarts it.
If it is another app (Android File Transfer, OpenMTP, calibre, Send to Kindle), the app names it
and asks you to quit it. You can turn this off in Settings.

Some newer Kindle models reportedly hide the `system` folder over USB. If yours does, the device
card says so, and you can still open a `vocab.db` file by hand (or drop it on the window).

## Features

- Detects Kindles on startup and on plug-in; imports automatically (can be turned off)
- Keeps every imported `vocab.db` as a snapshot, so you can build decks without the Kindle connected
- Book list with search and sorting; per-book word list with highlighted sentences
- Deck options: one card per lookup or per word, Cambridge + SMART vocabulary, parallel lookups,
  LLM explanation (OpenAI or Ollama, configured in Settings; the API key is stored encrypted)
- **Only new words**: skips words exported by earlier builds of the same book, and/or the
  words in an existing `.apkg` you choose (works with zstd-compressed Anki 2.1.50+ exports)
- Build history with logs; "Open in Anki" (double-click import), "Show in folder", Markdown

## Run from source

Requires Node.js 22+.

```bash
cd desktop
npm install
npm start
```

Other scripts:

| Script | What it does |
|---|---|
| `npm test` | Unit tests (vocab parsing, `.apkg` writer/reader, card builder, MTP client against a fake USB device) |
| `npm run probe` | Lists connected Kindles from the terminal; `npm run probe -- --extract vocab.db` copies the file. Useful for debugging device access, e.g. on a Mac |
| `npm run icon` | Re-renders `build/icon.png` |
| `npm run dist:win` | Windows installer + portable `.exe` in `dist/` |
| `npm run dist:mac` | macOS `.dmg` + `.zip` for the current Mac's architecture (must run on a Mac) |

## Building installers

- **Windows**: `npm run dist:win` produces `dist/Kindle-to-Anki-Setup-<version>.exe` and
  `dist/Kindle-to-Anki-<version>-portable.exe`. They are not code-signed, so SmartScreen
  shows "Windows protected your PC": click *More info → Run anyway*.
- **macOS**: on the Mac, `npm ci && npm run dist:mac`. The app is ad-hoc signed
  (`mac.identity: "-"`), which is enough to run a locally built app on Apple Silicon.
  A copy downloaded from the internet is quarantined by Gatekeeper; allow it in
  *System Settings → Privacy & Security → Open Anyway*, or run
  `xattr -dr com.apple.quarantine "/Applications/Kindle to Anki.app"`.
  For a properly signed and notarized build, pass your identity and enable the hardened runtime, e.g.
  `npx electron-builder --mac -c.mac.identity="Developer ID Application: …" -c.mac.hardenedRuntime=true`
  (the entitlements in `build/entitlements.mac.plist` already include USB access).
- **CI**: `.github/workflows/desktop.yml` builds Windows x64, macOS arm64 and macOS x64 on
  manual dispatch or when you push a `desktop-v*` tag, and uploads the files as workflow artifacts.

## Where things are stored

- Decks: `Documents/Kindle to Anki` by default (change it in Settings)
- App data (settings, vocab snapshots, build history, logs): Settings → *Open data folder*
  (`%APPDATA%\Kindle to Anki` on Windows, `~/Library/Application Support/Kindle to Anki` on macOS)

## Troubleshooting

- **Kindle not found**: use a data cable (not a charge-only one), unlock the Kindle and click the
  scan button. Settings → *Diagnostics* shows what the app saw. Copy it if you need help.
- **macOS: "in use by …"**: quit the named app. For Android File Transfer, also quit
  *Android File Transfer Agent* in the menu bar.
- **Linux** (not packaged, but `npm start` works): MTP needs USB permissions, e.g. a udev rule
  `SUBSYSTEM=="usb", ATTR{idVendor}=="1949", MODE="0666"`, and the desktop's own MTP mount
  (gvfs) must not hold the device.
