# Native Android Client (`android/`)

## Overview

The PPM Android app (`com.hienlh.ppm`) is a 100% native Kotlin + Jetpack Compose client for a self-hosted PPM server. Like the web workspace, the Android client communicates with the user's PPM server over HTTP/REST (`/api/*`) and WebSockets (`/ws/*`), while adapting its layout across phones (`< 768 dp`), tablets (`>= 768 dp`), foldables, and ChromeOS / desktop mode.

## Module Architecture

```
android/
├── core/protocol/       # Pure Kotlin/JVM wire types & JSON helpers (zero Android deps)
├── core/client/         # Pure Kotlin/JVM OkHttp REST & WebSocket client + ServerStore
├── core/state/          # Pure Kotlin/JVM state machines & business logic:
│   ├── ChatTranscript, Workspace, CommandPalette, Diff, GitStatus
│   ├── editor/          # Rope text buffer, Monarch syntax, LSP, blame/diff/conflict
│   ├── database/        # DBGate connections, 2D grid, filter DSL, edit/save, SQL query, DDL/impexp
│   ├── gitgraph/        # Topological lane allocator, insights, interactive rebase, reflog
│   ├── design/          # Design mode layout, canvas bridge protocol, tweaks, transform, check
│   ├── settings/        # 20 Settings sections state & validation
│   └── shell/           # Multi-window, foldable posture, cross-app drag-drop, onboarding, a11y
├── ui/design/           # Theme tokens (Aurora/Slate/Precision + custom VS Code), Geist/Monaspace, Shiki
├── ui/chat/             # Streaming markdown, Shiki code blocks, tool cards, approvals
├── ui/terminal-engine/  # ConnectBot termlib + libvterm (OSC 10/11/12 & DECRQM ?1049 parity)
├── ui/terminal/         # Compose terminal surface, selection, links, mobile toolbar
├── ui/media/            # Media3 video/audio player, PDF viewer
├── ui/web/              # HtmlSurface sandboxed WebView + postMessage FrameChannel
└── app/                 # MainActivity, ProjectWindowActivity, PhoneShell, TabletShell, feature UIs
```

## Data Flow & Security

1. **Server Connection & Keystore**:
   - Server credentials are encrypted at rest with AES-GCM backed by Android Keystore (`android:allowBackup="false"`).
   - Supports cleartext `http://` for LAN/Tailscale and first-use certificate fingerprint pinning for self-signed `https://`.
2. **Workspace & Multi-Window**:
   - `PpmApplication` retains the primary `AppModel` and per-window `AppModel` instances (`ProjectWindowActivity` launched with `FLAG_ACTIVITY_NEW_DOCUMENT | FLAG_ACTIVITY_MULTIPLE_TASK | FLAG_ACTIVITY_LAUNCH_ADJACENT`).
3. **Sandboxed HTML Surfaces (`:ui:web`)**:
   - WebViews are used strictly where the content itself is HTML: Design mode canvas (`10b`), Extension webviews (`10a`), Web Preview (`11a`), and HTML/DOCX file viewers (`06a`).
   - All parent↔child communication uses origin-pinned `WebViewCompat.addWebMessageListener` and cryptographic nonces (`design-bridge` v1).
4. **In-App Updates & Crash Diagnostics (`Phase 04` & `Phase 14`)**:
   - `AppUpdater` checks GitHub Releases (`android-vX.Y.Z`), verifies the APK signature certificate before handing to Android's package installer, and supports Obtainium.
   - Zero third-party analytics/crash SDKs: `inspectLatestCrashOrAnrExit` reads Android's `ApplicationExitInfo` (`REASON_CRASH`, `REASON_CRASH_NATIVE`, `REASON_ANR`) on startup and formats a markdown report for the user to copy into PPM's `Report Bug` dialog.

## User Setup Guide

1. **Install the APK**:
   - Download the signed APK from GitHub Releases and allow "Install unknown apps" when prompted.
2. **Connect to Your PPM Server**:
   - Enter your server URL (Cloudflare Tunnel, Tailscale URL, or LAN address) and password, or scan the connection QR code.
3. **Permissions & Battery Optimization**:
   - **Microphone**: Requested on first tap of the voice input button in Chat.
   - **Local Network (Android 17 / targetSdk 37)**: Allow local network access when connecting to a LAN or Tailscale IP.
   - **Battery Optimization**: Disable battery optimization for PPM if you keep long-running Terminal or Remote Desktop sessions open in the background.
