# CLAUDE.md

## Project

PPM (Project & Process Manager) — a web-based IDE/project manager with AI chat powered by Claude Agent SDK.

## Stack

- **Runtime**: Bun
- **Backend**: Hono (HTTP) + Bun WebSocket
- **Frontend**: React + Vite + Tailwind + shadcn/ui
- **AI**: @anthropic-ai/claude-agent-sdk
- **Tests**: bun:test

## Commands

```bash
bun dev:server    # Start backend dev (port 8081, uses ~/.ppm/ppm.dev.db)
bun dev:web       # Start Vite frontend (port 5173)
bun test          # Run all tests
bun test tests/integration/  # Integration tests only
```

## Dev Config

Config is stored in **SQLite** (`~/.ppm/ppm.db`). Dev uses a separate DB:

- **Dev**: `~/.ppm/ppm.dev.db` — port **8081**
- **Production**: `~/.ppm/ppm.db` — port **8080**

`bun dev:server` automatically uses the dev database. On a new machine, run `ppm init` to create default config, then `ppm config set port 8081` for dev.

## Release Process

1. Commit feature/fix changes
2. Update `CHANGELOG.md` with all changes
3. Bump version in `package.json` — patch for small changes, minor/major for large ones
4. Commit: `chore: bump version to x.x.x`
5. Publish: `npm publish --access public`

## Quick SDK Tool Test

Use `test-tool.mjs` to verify SDK tool execution against any project cwd:

```bash
bun test-tool.mjs /path/to/project                    # default: echo test
bun test-tool.mjs /path/to/project "dùng thử tool bash"  # custom prompt
```

This uses `ClaudeAgentSdkProvider` directly — same env/settings overrides as production.

## PPM Directory

**Never** use `resolve(homedir(), ".ppm")`, `join(homedir(), ".ppm")`, or `process.env.PPM_HOME || resolve(homedir(), ".ppm")` directly in service code.
Always import `getPpmDir()` from `src/services/ppm-dir.ts`. This ensures test isolation via `PPM_HOME` env var.

Exceptions (intentionally use real `homedir()`):
- `autostart-generator.ts` / `autostart-register.ts` — system service paths (launchd, systemd)
- `claude-usage.service.ts` — reads `~/.claude/` credentials (different dir)
- `fs-browse.service.ts`, `git-dirs.service.ts` — file browser starting from real home
- `ppmbot/` — bot files in real home
- `slash-discovery/` — discovers skills from real home
- `named-tunnel/cloudflared-cert.ts` — `~/.cloudflared` is where `cloudflared` itself writes `cert.pem`, not PPM's directory
- `fs-credential-path-guard.ts` — refuses `~/.cloudflared` (alongside the PPM dir) on every fs read/write/transfer door
- `db-backup/db-backup-paths.ts` — snapshots live in `~/.ppm-backups` *outside* the PPM dir on purpose, so they survive a wipe of it (under an isolated `PPM_HOME` they go back inside that temp dir)

## Known Gotchas

- **SDK .env poisoning**: Projects with `ANTHROPIC_API_KEY` in `.env` break SDK tool execution. Provider neutralizes these vars. See `docs/lessons-learned.md`.
- **File watching**: never `fs.watch(dir, { recursive: true })` on a project root — on Linux that is one inotify watch per subdirectory, `node_modules` included (it once cost 359k watches). Ignored dirs must be pruned at registration time via `src/services/file-watcher/watch-tree.ts`.
- **Project Claude settings**: `.claude/settings.local.json` can restrict tools even with `bypassPermissions`. Provider overrides with empty settings.
- **Transcript images live in two places**: the base64 payload sits at `message.content[].content[]` inside a tool result, but Claude Code also writes an image-shaped record at the top-level `toolUseResult` field carrying no payload. An assertion like "no `"type":"image"` remains" must be scoped to the former, or it fails against correct code.
- **Plugin items are named by location, not frontmatter**: Claude Code registers a plugin's skills and commands as `<plugin>:<path>` (`ak-engineer:ak-debug`) and only honours the frontmatter `name` for agents. Kits that self-namespace instead — AgentKit ships `name: ak:debug` — publish a name nothing can resolve. `slash-discovery` mirrors that rule and keeps the declared name as an alias; `src/server/ws/chat.ts` rewrites the alias to the canonical name before the message reaches the SDK.
- **Nested subagents are never streamed**: the SDK stamps `parent_tool_use_id` only on agents the session itself spawned. An agent that spawns another agent (a reviewer running `Skill code-review`, a planner calling researchers) produces **zero** stream events for that grandchild, so the Agent card would freeze on the forking step for minutes. Its transcript still lands in `<session>/subagents/agent-<id>.jsonl`, with a meta carrying only `parentAgentId` (raw id, no `agent-` prefix) and no `toolUseId`. `src/services/nested-subagent-spy.ts` tails those during the turn and `subagent-transcript-merger.ts` folds them in flat, time-ordered, on reload — both via `groupSubagentsByCard`, which walks the `parentAgentId` chain to the root card.
- **Agent teams are implicit and mostly not in `~/.claude/teams/`**: there is no `TeamCreate` tool any more. A team appears as `~/.claude/teams/<sessionId>/inboxes/*.json` with **no `config.json`**, so anything that requires a config sees no team at all. The inboxes only hold what was sent *to* each handle — in practice just the lead's task assignments — so they can neither say who is working nor show a teammate's replies. Both live in the agent transcripts under `~/.claude/projects/<slug>/<sessionId>/subagents/`: `agent-<id>.meta.json` maps the teammate `name` to its transcript, a transcript being appended to means that teammate is running, and its replies are `SendMessage` tool calls inside it. See `src/services/team-member-activity/`.

- **An extension panel only gets a tab if a browser tab asked for it**: `use-extension-ws.ts` creates a tab for `webview:create` only when `locallyDispatchedViews` holds a matching entry, i.e. when *this* client dispatched the command. A panel the extension opens on its own initiative exists server-side with no tab to show it. To open one panel from another, call `window.openTab("extension", …, { viewType })` instead — `extension-webview.tsx` then sees a tab with no panel and dispatches the command itself, which *is* a local dispatch. The recovery dispatch forwards only the project path, so any other argument has to be stashed for the target panel to pick up (`packages/ext-git-graph/src/panel-nav.ts`). The command id and the viewType must also be identical: both are turned into a tab slug by stripping a trailing `.view`, and a mismatch silently yields no tab.
- **Extensions may only spawn `git`, `node`, `bun`, `npx`, `sqlite3`** (`ALLOWED_SPAWN_COMMANDS` in `extension-rpc-handlers.ts`) and the call *throws* for anything else. Reaching for `test`, `cat` or any other coreutil looks fine in review and fails only at runtime — where a surrounding `catch` can turn it into silently missing data rather than an error. `env` is merged over `process.env` (so `PATH` survives) except for `BLOCKED_ENV_KEYS`; `GIT_SEQUENCE_EDITOR` and `GIT_EDITOR` are not blocked, which is what makes a non-interactive `git rebase -i` possible.
- **A webview panel has no `prompt`/`confirm`/`alert`**: `extension-webview.tsx` mounts the iframe with `sandbox="allow-scripts"` and nothing else, and a sandboxed `prompt()` returns `null` silently — no exception, no console warning. Any answer a panel needs has to be collected by markup it renders itself (`confirmHtml` in `reflog-view.ts`). The same string is a TypeScript template literal, so a backtick anywhere inside it — a `` `code span` `` in a comment is the usual one — ends the literal early and reports as a syntax error at some unrelated token far below.
- **A Monaco model in PPM is not named after its file**: the editor mounts `<Editor value=... />` with no `path`, so Monaco names models `inmemory://model/N`. A language server has never heard of that, and the `file:` URIs it answers with match no model — so an unrewritten request makes the server answer about a document it was never given, and an unrewritten response makes Monaco treat the open file as a different one (go-to-definition inside the current file tries to *open* it, and diagnostics attach to nothing and never appear). `src/server/ws/lsp.ts` rewrites both directions, including URIs used as object *keys* in a workspace edit's `changes`.
- **Standalone Monaco's F12 into another file hijacks the current editor**: its default editor service, once a model exists for the target, swaps that model into the editor you are in. The tab keeps its old title and its old dirty state while showing another file's contents. `lsp-navigation.ts` replaces the binding and opens a real tab instead. Peek and find-references are left on Monaco's bindings — they render in place and never navigate — but they need a model to exist for the target, which is what the shadow models in `lsp-shadow-models.ts` are for; there is no public way to give standalone Monaco a model *resolver*, so providers create the models before returning locations.
- **`Content-Length` in the LSP framing counts bytes, not characters**: one multi-byte character anywhere in a payload — a curly quote in a hover, a Vietnamese identifier, an emoji in a doc comment — makes a character-counting decoder cut the body short, fail to parse, then read the next message's header as body. The stream never recovers and it only happens for some files. Also bound the header search (`MAX_HEADER_BYTES`): a server writing a panic trace to stdout has no `\r\n\r\n` to find, so without a bound the decoder buffers forever and the session looks healthy while serving nothing.
- **`typescript-language-server` needs TypeScript 5.x**: the 7.x line is the native port and ships no `tsserver.js`, so the server exits at `initialize` with "provides no tsserver". It reads like a broken install rather than the wrong major version, so the registry's install hint pins `typescript@5`.
- **Standalone Monaco can never turn semantic highlighting on from a theme**: `StandaloneTheme` hardcodes `semanticHighlighting = false` and never reads it from the `defineTheme` data (`IStandaloneThemeData` has no such field), while the `semanticHighlighting.enabled` option defaults to `'configuredByTheme'` — so tokens are fetched, decoded, and change nothing. The only switch is the editor option set to `true` (`code-editor.tsx`). Colours then resolve through the *same* rule trie as TextMate scopes: `getTokenStyleMetadata` joins the type and its modifiers with dots (`variable.readonly.local`) and `ThemeTrieElement.match` falls back segment by segment, so a type with no rule lands on the theme's default foreground — i.e. plain text where the regex tokenizer had colour. `src/web/theme/semantic-token-rules.ts` is that table, and it must cover names outside the specification: `typescript-language-server` sends **`member`** for methods, one of the most common tokens in a TS file.
- **Monaco's bundled TypeScript service is off entirely, and `setDiagnosticsOptions` is not what does it**: that call silences the validator but leaves all **thirteen** providers in `modeConfigurationDefault` registered, so every `.ts` file had two completion lists and two hovers — the second from a worker that sees one file with no `tsconfig.json` and no `node_modules`. It also cost a *visible* stall: answering a hover at all means fetching `ts.worker.bundle.js` (**13 MB**, the whole TypeScript compiler), and Monaco's hover widget merges every provider and shows "Loading…" until the last one replies — so the real server's answer rendered in milliseconds and then sat behind a spinner. `setModeConfiguration` is the call that unregisters them (`monaco-builtin-typescript.ts`, asserted against Monaco's own default list so an upgrade adding a provider fails a test). Consequence, accepted: a buffer the LSP cannot serve — untitled, external, inline — falls back to word-based suggestions only.
- **A button in a Monaco hover is a `command:` link in *trusted* markdown, and trust is all-or-nothing unless you narrow it**: a hover can only contain markdown, so the blame hover's actions are `[label](command:id?args)` links reaching ids registered with `monaco.editor.registerCommand`. The renderer *strips* those links unless the `IMarkdownString` is trusted — and `isTrusted: true` allows **every** command on the page's global registry. That hover embeds a commit message, so anyone who can land a commit could write `[click](command:...)` in one and have it render as a working button. Both defences are needed and both are in `blame-hover.ts`: `isTrusted: { enabledCommands: [...] }` (an array is honoured by `toAllowCommandsOption`), and escaping the message so it cannot form a link at all. `supportHtml` stays **off** — the avatar is `![](data:image/svg+xml,...)`, which renders inline at its intrinsic size, so no HTML has to be allowed for it. Escape `<` and `>` too: with `supportHtml` off the renderer does not leave an unknown tag alone, it drops the tag and keeps the text, so a message mentioning a literal `<script>alert(1)</script>` displayed as `alert(1)` — the message silently rewritten in the one view meant to show it verbatim.
- **Hovering injected text does reach the decoration under it, and Monaco has no `diff` language**: an `after` injected-text annotation sits past the line's last column, and `ContentHoverComputer._getLineDecorations` relaxes its column check by one character *only* for `showIfCollapsed` decorations — which is what makes the blame hover work at all, and why that flag is load-bearing rather than cosmetic. `editor.action.showHover` opens the same hover from the cursor, which is the touch path (gated on `hover: none`, not on a width breakpoint; the mouse target's `injectedText` would identify the tap exactly but is not in Monaco's public typings, so the handler goes by column). Separately: Monaco's 91 basic languages include no `diff` — VS Code's comes from a bundled extension — so a fenced diff block runs the tokenizer and comes back entirely `mtk1`, the theme's default foreground. `monaco-diff-language.ts` registers one and `theme/diff-token-rules.ts` colours it; a Monarch rule whose token name has no theme rule is the same silent no-op as an unmapped semantic token, and a test pairs the two so neither can be added without the other.
- **The service worker's precache can silently undo any download saving, and both compressions are needed**: `injectManifest` defaults to precaching *everything* in the build output, so the first visit fetched 488 files / 33.3 MB — including the 12.7 MB TypeScript worker that `monaco-builtin-typescript.ts` had just made unnecessary to ever load. A saving measured in the network tab of a warm page is not a saving; measure `precache N entries (X KiB)` in the build output too. `globPatterns` now lists only the boot shell (9 entries / 1.08 MB) with everything else on a runtime `CacheFirst`. Separately, `scripts/precompress-web.ts` writes **both** `.br` and `.gz` siblings and `static-encoding.ts` picks one: brotli alone is not enough, because browsers advertise `br` only on a **secure origin** and PPM is routinely reached over plain HTTP on a LAN. And Monaco is staged locally by `scripts/copy-monaco.ts` with `loader.config({ paths: { vs: "/assets/monaco/vs" } })` — the default is jsdelivr, which means no editor offline and a third party told which files are opened. `vite build` empties `dist/web`, so `copy-monaco` and `precompress-web` must run *after* `build:web` (running `build:web` alone leaves an installed PPM with no Monaco at all).
- **A lazy chunk boundary is one static import away from not existing, and it is invisible**: `code-editor.tsx` reaches the language service only through `lazy(() => import("./editor-language-service"))`, which is what keeps the LSP client out of the editor's chunk and — the part that actually costs something — keeps the code that asks the host for a server unreachable until the setting is on. One `import { anything } from "@/hooks/use-lsp"` anywhere on that static path merges the chunk back in and nothing about the UI looks different, so `tests/unit/web/editor-lsp-lazy-boundary.test.ts` enumerates the offenders instead. Importing even a *constant* from the lazy module counts; `import type` does not. Related: `lspEnabled` and `mobileWordWrap` are written with `persistDevicePref` (localStorage only) rather than `persistUiPref`, because the server round-trip that makes prefs survive an origin change also means the last device to write wins everywhere — and a desktop must not start an 854 MB server process for a phone.
- **`vscode.languages` and every editor API are absent for extensions**: no `activeTextEditor`, no `setDecorations`, no hover providers. Anything GitLens-shaped that wants to annotate code has to render its own view in a webview panel.
- **Remote desktop on macOS (avfoundation)**: address the screen by **name** (`-i "Capture screen 0"`), never by index — the device list reorders at runtime when a Continuity Camera joins (index 3 became the iPhone). `-framerate` is ignored (the screen input delivers at display refresh, 120–165 fps, with a stuck pts) → `-use_wallclock_as_timestamps 1` + `-vf fps=30`. ffmpeg-avfoundation ignores SIGTERM/SIGINT → `proc.kill("SIGKILL")` or it leaks one process per session. No Screen Recording grant = **black frames, no error**; no Accessibility grant = silent no-op input — both are pre-flighted in `remote-desktop-requirements.ts`, never inferred from failures. TCC keys the grant to the `bun` executable.
- **Remote desktop text injection on macOS**: `CGEventKeyboardSetUnicodeString` still carries a keycode, and IMEs that hook by key (OpenKey/EVKey) re-read keycode 0 as a literal "a" (`"日本"` → `"â"`); function/unassigned keycodes produce no text at all. The carrier is Space (`TEXT_CARRIER_KEYCODE`). Text is still subject to the host's active IME (Telex rewrote "World" → "ửold") on every OS.

## UI Rules

When creating or modifying any UI component, you MUST read and follow `docs/design-guidelines.md`, especially the **Mobile-First UI Rules** section. Key rules:
- Dialogs → bottom sheet on mobile (below `md:` breakpoint)
- No hover-only interactions — must have touch alternatives
- Touch targets minimum 44×44px
- Context menus → long-press on mobile, not tap
- Thumb zone: primary actions in bottom 1/3 of screen for one-handed use
- Always test both mobile and desktop layouts

### Reusable Adaptive Components

- **Context menus**: Always use `@/components/ui/adaptive-context-menu` instead of `@/components/ui/context-menu`. It auto-detects mobile (< 768px) and renders a bottom sheet with long-press trigger instead of radix right-click menu. Same API — just swap the import path. Sub-menus are flattened inline on mobile.
- **Mobile detection**: Use `useIsMobile()` from `@/hooks/use-is-mobile` for reactive mobile breakpoint checks.

## Roadmap & Context

Before planning or implementing a new feature, read `docs/project-roadmap.md` to understand:
- Which version the feature belongs to (v0.8, v0.9, v0.10, v1.0)
- The theme and scope of that version
- Dependencies between features
- Strategic principles (multi-device focus, extension architecture, tiered providers)

## Architecture

- `src/providers/claude-agent-sdk.ts` — SDK integration, tool execution, streaming
- `src/server/ws/chat.ts` — WebSocket chat handler
- `src/web/hooks/use-chat.ts` — Frontend chat state management
- `src/services/config.service.ts` — Config from SQLite (`~/.ppm/ppm.db`)
- `src/web/components/floating-window/` — Desktop window manager (drag/resize/z-band/persistence), OS-agnostic
- `src/web/components/os-explorer/` — OS File Explorer window body: views (List/Icons/Column), skins, mobile sheet, actions, drag-and-drop
- `src/web/components/settings/` — Settings as its own window kind (`settings-window-content.tsx`) and, below `md` where the window layer does not render, a tab (`settings-tab.tsx`); both mount one `settings-body.tsx`, which picks split-vs-stacked from its OWN width via `@container` — never `useIsMobile()`, because a narrow sidebar is not a phone. Tree in `settings-categories.ts`, id→pane map in `settings-section-content.tsx`, viewport routing in `open-settings.ts` (plain function: the global keybinding handler is not a component). `accounts/` is the single home for account management, one sub-tab per configured provider (Claude + Codex; the tab only shows when that provider is in `ai.providers`). Every provider pane is built from the same parts — `accounts-pane-header.tsx` (header + message strip + `AccountCardShell`) and `account-bucket-row.tsx` (`AccountUsageBar`) — and puts every action behind a dialog, so the sub-tabs cannot drift into different designs again — the chat usage chip and AI Provider’s Codex tab only display and link here. e2e `tests/e2e/settings-window-e2e.mjs`
- `src/services/fs-ops/` — Guarded whole-disk filesystem operations (`/api/fs/*`) behind PPM auth
- `src/services/host-info/` — Per-OS drives/known-folders/pinned-folders providers (`/api/system/host`)
- `src/services/system-metrics/` — Task Manager backend (`/api/system/resources*`): per-OS collectors, one long-lived PowerShell child on Windows (never spawn per tick — 32 MiB commit leak each), light/full SSE tiers with leases, guarded kill. UI in `src/web/components/system/` (floating window on desktop, tab on mobile)
- `src/services/db-backup/` — verified `VACUUM INTO` snapshots of `ppm.db` (hourly + at start + before every migration), GFS retention, `ppm backup` / `ppm restore`
- `src/services/remote-desktop/` — Remote Desktop: one ffmpeg per WS session (`remote-desktop-capture.ts` + per-platform `remote-desktop-capture-input.ts` + `remote-desktop-encoder-args.ts`) → Annex-B H.264 access units → WebCodecs; input via `remote-desktop-input.ts` facade over `remote-desktop-input-{win32,darwin}.ts` (bun:ffi, no helper binary); host checklist in `remote-desktop-requirements.ts` (ffmpeg install command, macOS TCC pre-flight); display list in `remote-desktop-displays.ts` (`CGGetActiveDisplayList` order = avfoundation `Capture screen N`, names/bounds via one JXA call). Routes `src/server/routes/remote-desktop.ts`, WS `src/server/ws/remote-desktop.ts`, UI `src/web/components/remote-desktop/`, e2e `tests/e2e/remote-desktop-e2e.mjs`
- `src/services/git-hunks/` — hunk/line-level stage, unstage and discard (`/api/projects/:name/git/{hunks,stage-hunks,unstage-hunks,discard-hunks}`). `unified-diff.ts` holds the patch surgery (recomputed `@@` counts, unselected deletions demoted to context); the UI is `src/web/components/git/hunk-stage-dialog.tsx`
- `src/services/lsp/` — language servers for the editor. `server-registry.ts` says which binary serves which language and how to find it (project `node_modules/.bin` before PATH), `lsp-protocol.ts` is the `Content-Length` framing, `lsp-session.ts` owns one child process, `lsp-manager.ts` decides how many exist and shares them by *server + root directory*. Bridge at `src/server/ws/lsp.ts` on `/ws/project/:name/lsp`, status at `/api/projects/:name/lsp/status`. Browser side in `src/web/lib/lsp/` (client, Monaco conversions, providers, shadow models, F12 navigation) driven by `src/web/hooks/use-lsp.ts`. All of it is behind the `lspEnabled` setting — off by default, per device, never on below the `md` breakpoint — and mounted by `src/web/components/editor/editor-language-service.tsx`, which `code-editor.tsx` may only reach through `lazy()`. Real-server check: `bun tests/e2e/lsp-e2e.ts`
- `src/web/components/problems/` + `src/web/stores/problems-store.ts` — the Problems panel: a dock tab (`DOCK_ALLOWED_TAB_TYPES`) fed by every mounted editor's `useLsp`, opened from the status bar counts on desktop and the editor's LSP row on mobile. Scoped to the active project because `tab-pool` keeps other projects' editors mounted for keep-alive, so their servers keep publishing
- `src/services/git-blame/` — `git blame --porcelain` for the editor's inline annotation (`/api/projects/:name/git/blame`); shared shape and formatting in `src/shared/blame.ts`, editor wiring in `src/web/hooks/use-inline-blame.ts`. The annotation's GitLens-style hover adds one `git show --unified=0` per commit *and line* (`/git/commit-line`, parsed by `commit-line-diff.ts`), with the markdown built in `src/web/lib/blame-hover.ts` and its buttons registered in `blame-hover-commands.ts`, which hand off to the Git Graph extension's own views over `ext:command:execute`
- `dist/web` asset pipeline — `scripts/copy-monaco.ts` stages `monaco-editor/min/vs` under `dist/web/assets/monaco/` (inside `assets/` so it inherits the immutable cache header, the SW runtime cache and the compressed siblings), `scripts/precompress-web.ts` writes `.br`/`.gz` siblings, and `src/server/routes/static-encoding.ts` chooses one per request (honouring `q=0` and `*`, keeping the original MIME, adding `Vary: Accept-Encoding` and the encoding in the ETag). Both scripts run after `build:web` in the `build` chain
- `src/services/named-tunnel/` — Named tunnel (stable `https://<prefix>.<zone>` URL via Cloudflare login), orchestrated from `src/server/routes/named-tunnel.ts`, spawned/probed by the supervisor; UI in `src/web/components/tunnels/named-tunnel/`
