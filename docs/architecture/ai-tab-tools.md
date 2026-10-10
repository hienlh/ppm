# AI tab tools

> Part of [AI Chat & Providers](ai-chat-and-providers.md#ai-tab-tools).

PPM's own answer to claude.ai's Artifact tool. The AI writes a file and calls a tool, and the
file opens in a PPM tab on the device the user is chatting from: `open_file` (optional
`line`) for any file the user asks to see, `open_preview` for a page, chart, report or mockup
the AI made, which also returns how the page rendered. Because PPM serves the page, it works
wherever PPM is reached — LAN, tunnel, phone — and a script, stylesheet or font may come from
the design CDNs.

**The setting.** Settings → AI Provider → *Let the AI open tabs in PPM* (`ai.tab_tools`, off by
default). While it is on, every chat that is not a design session is given both tools (a
design session checks its canvas with `design_check` instead), and Claude is spawned with
`CLAUDE_CODE_DISABLE_ARTIFACT=1`, which removes `Artifact`, `ArtifactComments` and
`ArtifactData`. A chat keeps the MCP servers its process started with, so turning the setting
on reaches chats started afterwards, and turning it off is enforced by the endpoint itself:
a call made after that is refused with a message that says why.

**How a call travels.**

1. `chatService.prepareSendOptions` adds `tabToolsMcp` — `{ url, token }` from
   `tabToolsMcpAccessFor`, on the port the server actually bound — to every turn.
2. Claude gets it as the `http` MCP server `ppm-tabs` (`tabToolsMcpServers`), the token in
   `Authorization`, a 60 s timeout, and both tools allowed by the PreToolUse hook without a
   prompt (`CLAUDE_TAB_TOOLS`). A warm spare is started with the server but no token; the token
   is minted when the spare is adopted, for the session id it is adopted with, and
   `withSessionTokenMasked` keeps it out of the spawn fingerprint. Codex gets
   `mcp_servers.ppm_tabs` on `thread/start`/`thread/resume` (`tabToolsMcpConfig`) with
   `bearer_token_env_var`, so the token lives only in that app-server's environment, plus
   `enabled_tools`, `default_tools_approval_mode = "approve"` and `tool_timeout_sec = 60`.
3. `/api/tab-tools-mcp` (`tab-tools-mcp-endpoint.ts`, mounted before auth) resolves the token
   to its session, checks the setting, and resolves `path` (`tab-target.ts`): absolute, `~`, or
   relative to the session's project; it must exist and be a file, and it goes through the
   editor's own read rules (`assertReadPermitted`, so the PPM directory and `~/.cloudflared`
   are refused) — checked here so the AI hears why rather than the user seeing a tab that
   cannot load. A file inside the project is named relative to it, the way the file explorer
   names it, so a tab the user already has open for it is the one reused.
4. `tab-open-broker.ts` sends `tab_open` (`src/shared/tab-open-protocol.ts`) through
   `deliverTabOpen` in `src/server/ws/chat.ts`: to the socket that sent the turn's message
   (`lastSender`), or, when that one has gone, to every socket showing the chat. It is never
   buffered into `turnEvents` — a device reconnecting later must not open the tab again. The
   first `tab_open_result` settles the call: 8 s for `open_file`, 40 s for `open_preview`.
5. In the browser, `use-chat.ts` hands `tab_open` to `answerTabOpen` (`src/web/lib/open-ai-tab.ts`)
   ahead of any replay queue, because the server is waiting. It brings up the chat's workspace
   if another project is on screen, opens the tab, and for an HTML page waits for a load newer
   than the one it saw before (`html-preview-loads.ts`, up to 12 s), lets the page's scripts
   draw for 1.5 s, and runs the design canvas's self-check through the preview's bridge
   (`runCanvasCheck`): script errors, failed loads, CSP violations, layout findings and a
   screenshot. Every outcome is answered, including failures, so the AI never waits out the
   timeout because a device stayed silent.
6. The endpoint turns the report into text (`formatPreviewCheck`: viewport, page size, each
   problem fenced as untrusted, "fix them and call again") with the screenshot as an MCP image
   block, unless the AI passed `screenshot: false`. Markdown, images, PDF and CSV open in PPM's
   viewers and are not checked.

**Where the tab goes** (`ai-tab-placement.ts`, pure). On a desktop the chat stays on screen:
the file opens in another panel, and when the chat's panel is the only one it is split so the
file sits to the chat's right. A tab already showing the file is brought to the front, or
moved out beside the chat when it was hidden behind it in the chat's own panel. A phone shows
one panel at a time, so there the tab opens in the first panel and takes the screen; the tab
bar leads back to the chat. Every call stamps `aiView` and `aiOpenAt` on the tab's metadata,
which `code-editor.tsx` reads: `line` switches the tab to code at that line, `open_preview` to
the preview and reloads it, in a tab that was already open too.

**The HTML preview** now serves the design canvas's policy (`buildDesignCsp`): the same
`sandbox allow-scripts`, plus scripts, styles, fonts and images from the design CDNs, with
`connect-src` still limited to the preview's own files. An HTML page up to 32 MB is served with
`design/bridge/html-preview-bridge.ts` as the first thing in its `<head>` — the design bridge's
core and its self-check, with nothing that selects, edits or blocks links — and every load has
its own nonce (`?n=`). A bigger page is served as it is, unchecked, and so is a UTF-16 one,
which the browser reads by its byte-order mark (Windows PowerShell's `Out-File` writes them).

**The card.** `tab-tool-call.ts` recognises both providers' names — `mcp__ppm-tabs__<tool>`
for Claude, `ppm_tabs:<tool>` for Codex, whose input is wrapped as
`{ server, tool, arguments }` both live and in history — and `tool-cards.tsx` renders
`tab-tool-card.tsx`: what was opened, the check's problem count, the result text (Codex's
`[image]` label dropped), and an Open button that brings the tab back through the same
`openAiTab` — from history, after the tab was closed, or on another device. The screenshot
is not in the chat's history (images are stripped from tool results), so the card does not
show it; Open shows the live page.

**A renamed session.** Codex renames a new chat to its thread id during the first turn, after
the token was minted under PPM's id, and `ws/chat.ts` moves the chat's sockets to the new id.
The broker keys its pending calls, limits and delivery by `resolveMigratedSession`
(`setTabOpenDelivery(deliverTabOpen, resolveMigratedSession)`), so a call made under the old
id still reaches the chat. Before that, every call in a new Codex chat answered "no device".

**Limits and trust.** The token can do exactly one thing — open a tab on its own session's
devices, for a file the agent could already read — and is held in memory only, looked up by
its SHA-256 (`mcp-session-tokens.ts`, shared with `/api/design-mcp`). Deleting the chat
revokes it and a restart revokes every one; the token a Codex chat was given under PPM's id,
before the rename, outlives the chat's deletion until that restart. The
endpoint (`mcp-http-endpoint.ts`, also shared) refuses a request carrying an `Origin` and caps
a body at 64 KB. A session may have 4 calls in flight and 20 a minute (64 pending in all), so an
agent talked into opening tabs in a loop stops there. A device's answer settles only a call
pending for its own session, and is parsed like a design check's (`parseTabOpenResult`),
since the page's own scripts can write anything into the report; the device's error text has
its control characters stripped and its fences neutralised before the AI reads it.

**What real models did** (Opus 5.5 at effort high, Codex 0.160, on a scratch PPM):

| Scenario | Outcome |
|---|---|
| Claude, sales dashboard | `open_preview` 5 s after the Write; the check found nothing, but the screenshot showed the table's last columns cut off at 541 px — fixed, called again |
| Claude, page with a 404'd chart library | problem reported → fixed → clean, 73 s |
| Claude, `open_file` with a line | the config file, then line 20, 28 s |
| Claude, from a phone | opened full screen; the check ran at 390x748 |
| Claude, no browser open | told at once; it named the file's path instead |
| Codex, the same broken page | 2 problems → fixed → clean, 107 s |
| Codex, `open_file` with a line | 38 s |

Two findings shaped the tool description. With the user's Playwright MCP available, the first
description made Opus check the page in its own headless browser for four minutes (28
Playwright calls) and open the tab only at the very end, so the user watched nothing; saying
*when* to call — as soon as the file is written, because the user watches while you fix — and
that the check needs no browser of its own moved the call to 5 s after the Write (Codex's came
34 s after its Write). Opus still opened its own browser afterwards, but only for what the
check cannot see: hover tooltips and dark mode. That first run had also inherited a max
effort, so the two changes are not separated. And Claude Code 2.1.280+ defers MCP tools, so a session's first call to either tool
is preceded by a `ToolSearch`.

Verify with `PPM_PLAYWRIGHT_MODULE=<playwright>/index.mjs node tests/e2e/ai-tab-tools-e2e.mjs`:
a scripted provider (`tests/e2e/fixtures/tab-tools-server.ts`) calls the real endpoint with the
token each turn was handed, on the production bundle and an isolated `PPM_HOME`, and the test
checks where the tab lands on a desktop and a phone, a tab that was already open being reloaded,
a line in code view, the card's Open button, the setting turned off, and a chat with no browser.
`PPM_TAB_TOOLS_WEB_DIR` reuses a scratch build. `tests/e2e/html-preview-cdn-check-e2e.mjs`
covers the preview's CDN loads and its self-check on their own. Both need internet for the CDNs.
