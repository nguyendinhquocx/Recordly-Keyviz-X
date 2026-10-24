Language: EN | [简中 (upstream docs)](README.zh-CN.md)

<p align="center">
  <img src="https://img.shields.io/badge/license-AGPL--3.0-2563eb?style=flat-square" alt="AGPL 3.0 license" />
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-111827?style=flat-square" alt="Platforms" />
  <img src="https://img.shields.io/badge/key%20overlay-Windows%2010%2B-059669?style=flat-square" alt="Keyboard overlay: Windows 10+" />
</p>

# Recordly — community fork

Recordly is an open-source screen recorder and editor for walkthroughs, demos, and product videos: automatic zooms, cursor polish, styled frames, webcam bubbles, and a timeline editor in one desktop app.

**This fork extends upstream [`webadderallorg/Recordly`](https://github.com/webadderallorg/Recordly) with a built-in keyboard overlay, global recording hotkeys, and a Vietnamese-first interface.** It is not affiliated with the upstream author; the base app is their work, and the additions below are the fork's.

## What this fork adds

- **Keyboard & mouse overlay in recordings (Windows)** — a bundled [Keyviz](https://keyviz.org) sidecar renders your keystrokes and clicks into the video. Toggle it from the recording HUD; no separate Keyviz install needed.
- **Global recording hotkeys** — start / stop / pause-resume (default `Ctrl+Alt+Shift+R` / `S` / `P`) work while Recordly runs, even unfocused. Bindings are editable alongside the 6 editor shortcuts, with conflict checking in both directions.
- **Vietnamese by default** — first launch runs in Vietnamese; the saved locale always wins, and 12 locale folders ship with key-parity checks (`npm run i18n:check`).
- **Privacy-conscious overlay lifecycle** — the input listener only runs while a recording is actually capturing. It stops on pause, stop, cancel, and app exit. The control hotkeys themselves are filtered out of the overlay, and the settings window never captures keystrokes.
- **Clean sidecar packaging** — the Windows package bundles the sidecar executable with Keyviz's GPLv3 license, the vendored rdev MIT license, and third-party notices. If the standalone Keyviz app is running, Recordly asks you to close it instead of killing or overwriting it.
- **Separate-clip Local export** — export every valid timeline clip as its own MP4 with one batch action and one folder choice; full-timeline MP4/GIF and Link flows remain available.

> [!IMPORTANT]
> The keyboard overlay and recording hotkeys are **Windows-only** in this fork. Everything else works cross-platform as upstream.

> [!TIP]
> **Windows installer:** grab the latest build from the fork's [Releases](https://github.com/nguyendinhquocx/Recordly-Keyviz-X/releases). Upstream [releases](https://github.com/webadderallorg/Recordly/releases) exist but do not include the fork features; macOS/Linux builds are source-only for now.

---

## The base app

Recording captures a display or a single window, then jumps into a timeline editor:

- Auto-zoom suggestions, cursor smoothing/click effects, styled frames with wallpapers and gradients
- Webcam bubble overlay with presets, mirroring, and zoom-reactive scaling
- Trim, speed regions, annotations, extra audio regions, cropping
- MP4 and GIF export
- `.recordly` project files preserve editor state
- Extensions system (upstream marketplace)

---

# Installation

## Build from source (Windows — gets you the overlay)

Prerequisites:

- Node.js LTS and npm
- Visual Studio 2022 or Build Tools with the C++ workload and CMake
- [Rust](https://rustup.rs/) and pnpm `10.18.2` (the version pinned by `keyviz/package.json`) — only needed for the Keyviz sidecar

```bash
git clone https://github.com/nguyendinhquocx/Recordly-Keyviz-X.git recordly
cd recordly
npm install
npm run build:win        # builds the Keyviz sidecar automatically, then the Windows package
npm run smoke:packaged-binaries
```

The unpacked app lands in `release/win-unpacked`; the installer lands in `release/`. Run `npm run dev` for development — the sidecar talks over stdio JSON, spawns only during capture, and exits on its own when Recordly closes.

Quick verification without a full build:

```bash
npm run typecheck
npm run i18n:check
npm test -- electron/ipc/keyvizSidecar.test.ts electron/ipc/globalShortcuts.test.ts
```

## Build from source (macOS / Linux)

The base app builds as upstream:

```bash
npm install
npm run build:mac    # or build:linux
```

Prerequisites are the same as [upstream](https://github.com/webadderallorg/Recordly#installation): Xcode Command Line Tools on macOS; `build-essential cmake libx11-dev libxtst-dev libxrandr-dev libxt-dev` on Debian/Ubuntu. The keyboard overlay is not included on these platforms.

---

## Keyboard overlay and hotkeys (Windows)

- Toggle the overlay with the keyboard icon on the recording HUD. On by default; off means the next recording starts without the overlay and without the global input listener.
- Configure overlay appearance in the native Keyviz settings window (gear icon on the HUD → "Keyviz settings"). This window never captures keystrokes.
- Set shortcuts — 6 editor actions plus 3 recording hotkeys — under "Keyboard shortcuts" on the HUD before recording. A chord that collides with another binding is rejected in both directions, and OS-level registration failures are shown per binding instead of being swallowed.
- While you rebind a key, global hotkeys are suspended so the dialog can receive the chord; if a renderer crashes mid-capture, the main process re-registers them automatically.

## Usage

1. Launch Recordly, pick a screen or window, choose audio sources, record.
2. Stop recording to open the editor; save work as `.recordly`.
3. Export MP4 or GIF. Local MP4 also offers Full timeline or Separate clips; GIF remains Full timeline.

# System requirements

| Platform | Minimum | Notes |
|---|---|---|
| Windows | 10 20H1 (Build 19041) | Required for the native WGC helper; older builds fall back to Electron capture and may show the real cursor. |
| macOS | 14.0 (Sonoma) | ScreenCaptureKit-based capture helpers. |
| Linux | Modern distro | Electron capture; system audio usually needs PipeWire. |

# How it works

Electron coordinates capture, editing, and export; macOS and Windows use native capture helpers (ScreenCaptureKit / Windows Graphics Capture + WASAPI); PixiJS renders the scene for both preview and export. On Windows, a Tauri-based Keyviz sidecar joins as a child process during capture, receiving capture start/stop commands and suppressed-hotkey chords over stdio JSON — no network sockets, no key logging.

Project docs: [`RELEASING.md`](./RELEASING.md) (release/build notes) · [`TRANSLATION_GUIDE.md`](./TRANSLATION_GUIDE.md) (adding locales) · [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) · [`CONTRIBUTING.md`](./CONTRIBUTING.md).

# License

- Recordly is licensed under the **AGPL 3.0** — same as upstream.
- The bundled Keyviz sidecar is **GPLv3** ([mulaRahul/keyviz](https://github.com/mulaRahul/keyviz)); the vendored `rdev` crate is MIT. Full license texts ship inside the Windows package under `resources/keyviz/`, summarized in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

# Credits

- [**@webadderall**](https://x.com/webadderall) — creator of Recordly and its upstream maintainer. This fork would not exist without their work.
- Recordly started as a fork of [OpenScreen](https://github.com/siddharthvaddem/openscreen); much of the zoom machinery traces back there.
- [Keyviz](https://keyviz.org) by [mulaRahul](https://github.com/mulaRahul) — the keyboard/mouse overlay engine, integrated as a sidecar in this fork.
- Fork additions (overlay integration, hotkeys, Vietnamese localization) maintained by [@nguyendinhquocx](https://github.com/nguyendinhquocx). Bug reports and PRs go to [this fork's issues](https://github.com/nguyendinhquocx/Recordly-Keyviz-X/issues); upstream concerns go to [upstream issues](https://github.com/webadderallorg/Recordly/issues).
