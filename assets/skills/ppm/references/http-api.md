# PPM HTTP API

_Auto-generated. Do not edit._

_Base URL: `http://localhost:8080` (default; override via `ppm config set port <n>`)._

## /

- `GET    *`

## /api/accounts

- `GET    /api/accounts`
- `GET    /api/accounts/active`
- `POST   /api/accounts/pick`
- `GET    /api/accounts/settings`
- `PUT    /api/accounts/settings`
- `POST   /api/accounts`
- `GET    /api/accounts/oauth/start`
- `GET    /api/accounts/oauth/url`
- `POST   /api/accounts/oauth/exchange`
- `GET    /api/accounts/oauth/callback`
- `POST   /api/accounts/oauth/refresh/:id`
- `POST   /api/accounts/export`
- `POST   /api/accounts/import`
- `GET    /api/accounts/usage`
- `GET    /api/accounts/:id/usage`
- `GET    /api/accounts/:id/usage-history`
- `POST   /api/accounts/:id/verify`
- `POST   /api/accounts/test-export`
- `POST   /api/accounts/test-raw-token`
- `POST   /api/accounts/:id/test-token`
- `DELETE /api/accounts/:id`
- `PATCH  /api/accounts/:id`

## /api/ai-resources

- `GET    /api/ai-resources`
- `GET    /api/ai-resources/content`
- `PUT    /api/ai-resources/content`
- `POST   /api/ai-resources`
- `POST   /api/ai-resources/duplicate`
- `DELETE /api/ai-resources`

## /api/android

- `GET    /api/android/android`
- `GET    /api/android/auth`
- `GET    /api/android/capabilities`
- `GET    /api/android/auth`
- `GET    /api/android/devices`
- `POST   /api/android/avds/:avdId/start`
- `GET    /api/android/operations/:id`
- `POST   /api/android/devices/:deviceId/stop`
- `GET    /api/android/devices/:deviceId/log`
- `POST   /api/android/devices/:deviceId/sessions`
- `GET    /api/android/devices/:deviceId/screenshot`
- `GET    /api/android/devices/:deviceId/clipboard`
- `POST   /api/android/devices/:deviceId/clipboard`
- `POST   /api/android/operations/:id/cancel`
- `POST   /api/android/devices/:deviceId/apk`
- `POST   /api/android/devices/:deviceId/apk/project`
- `GET    /api/android/projects`
- `GET    /api/android/projects/:project/apks`
- `GET    /api/android/projects`
- `GET    /api/android/system-images`
- `GET    /api/android/device-profiles`
- `POST   /api/android/avds`
- `POST   /api/android/avds/:avdId/wipe`
- `DELETE /api/android/avds/:avdId`

## /api/chat

- `GET    /api/chat/sessions/running`
- `POST   /api/chat/sessions/read`

## /api/cloud

- `GET    /api/cloud/status`
- `GET    /api/cloud/cloud_url`
- `POST   /api/cloud/login`
- `GET    /api/cloud/cloud_url`
- `POST   /api/cloud/logout`
- `POST   /api/cloud/link`
- `POST   /api/cloud/unlink`
- `GET    /api/cloud/alias`
- `PATCH  /api/cloud/alias`
- `GET    /api/cloud/login-url`
- `GET    /api/cloud/cloud_url`

## /api/codex-accounts

- `GET    /api/codex-accounts`
- `GET    /api/codex-accounts/usage`
- `POST   /api/codex-accounts/pick`
- `PATCH  /api/codex-accounts/:id`
- `POST   /api/codex-accounts/:id/reset-credit`
- `PUT    /api/codex-accounts/strategy`
- `POST   /api/codex-accounts/api-key`
- `POST   /api/codex-accounts/device-login`
- `GET    /api/codex-accounts/device-login/:id/status`
- `DELETE /api/codex-accounts/device-login/:id`
- `POST   /api/codex-accounts/browser-login`
- `POST   /api/codex-accounts/browser-login/:id/callback`
- `GET    /api/codex-accounts/browser-login/:id/status`
- `DELETE /api/codex-accounts/browser-login/:id`
- `POST   /api/codex-accounts/export`
- `POST   /api/codex-accounts/import`
- `DELETE /api/codex-accounts/:id`

## /api/db

- `GET    /api/db/ssh/agent`
- `GET    /api/db/connections`
- `GET    /api/db/connections/export`
- `POST   /api/db/connections/import`
- `POST   /api/db/connections/folder`
- `POST   /api/db/connections/:id/duplicate`
- `GET    /api/db/connections/:id`
- `GET    /api/db/connections/:id/config`
- `POST   /api/db/connections`
- `PUT    /api/db/connections/:id`
- `DELETE /api/db/connections/:id`
- `POST   /api/db/test`
- `POST   /api/db/connections/:id/login`
- `POST   /api/db/connections/:id/disconnect`
- `POST   /api/db/connections/:id/test`
- `GET    /api/db/connections/:id/tables`
- `GET    /api/db/connections/:id/schema`
- `GET    /api/db/connections/:id/data`
- `POST   /api/db/connections/:id/query`
- `PUT    /api/db/connections/:id/cell`
- `DELETE /api/db/connections/:id/row`
- `POST   /api/db/connections/:id/rows/delete`
- `POST   /api/db/connections/:id/row`
- `GET    /api/db/connections/:id/export`
- `GET    /api/db/search`

## /api/extensions

- `GET    /api/extensions`
- `GET    /api/extensions/contributions`
- `GET    /api/extensions/:id{.+}`
- `POST   /api/extensions/install`
- `POST   /api/extensions/dev-link`
- `DELETE /api/extensions/:id{.+}`
- `PATCH  /api/extensions/:id{.+}`

## /api/fs

- `GET    /api/fs/browse`
- `GET    /api/fs/list`
- `GET    /api/fs/read`
- `POST   /api/fs/download/token`
- `GET    /api/fs/raw`
- `GET    /api/fs/probe`
- `GET    /api/fs/transcode`
- `DELETE /api/fs/transcode`
- `GET    /api/fs/docx-html`
- `POST   /api/fs/mkdir`
- `PUT    /api/fs/write`
- `GET    /api/fs/stat`
- `POST   /api/fs/copy`
- `POST   /api/fs/move`
- `POST   /api/fs/rename`
- `POST   /api/fs/touch`
- `DELETE /api/fs/delete`
- `DELETE /api/fs/rmdir`
- `PUT    /api/fs/upload`

## /api/group-chat

- `GET    /api/group-chat`
- `POST   /api/group-chat`
- `GET    /api/group-chat/:id`
- `PATCH  /api/group-chat/:id`
- `POST   /api/group-chat/:id/members`
- `PATCH  /api/group-chat/:id/members/:memberId`
- `DELETE /api/group-chat/:id/members/:memberId`
- `GET    /api/group-chat/:id/feed`
- `GET    /api/group-chat/:id/transcript`
- `POST   /api/group-chat/:id/message`
- `POST   /api/group-chat/:id/stop`
- `POST   /api/group-chat/:id/resume`
- `DELETE /api/group-chat/:id`

## /api/logs

- `GET    /api/logs`
- `GET    /api/logs/around`
- `GET    /api/logs/issues`
- `GET    /api/logs/issues/summary`
- `POST   /api/logs/issues/analyze`
- `POST   /api/logs/issues/auto`
- `POST   /api/logs/issues/undismiss-all`
- `POST   /api/logs/issues/:id/dismiss`
- `POST   /api/logs/issues/:id/undismiss`
- `POST   /api/logs/report/draft`
- `GET    /api/logs/environment`
- `GET    /api/logs/github/labels`
- `GET    /api/logs/github/duplicates`

## /api/loopback

- `POST   /api/loopback/callback`

## /api/lsp

- `GET    /api/lsp/status`
- `GET    /api/lsp/projectPath`
- `POST   /api/lsp/install`
- `GET    /api/lsp/projectPath`
- `GET    /api/lsp/servers`
- `POST   /api/lsp/install`
- `POST   /api/lsp/uninstall`

## /api/mcp-auth

- `GET    /api/mcp-auth/status`
- `POST   /api/mcp-auth/start`
- `GET    /api/mcp-auth/flows/:id`
- `POST   /api/mcp-auth/flows/:id/callback`
- `POST   /api/mcp-auth/flows/:id/confirm`
- `DELETE /api/mcp-auth/flows/:id`
- `GET    /api/mcp-auth/state`

## /api/notifications

- `GET    /api/notifications/device_name`
- `GET    /api/notifications/settings`
- `GET    /api/notifications/notifications`
- `PUT    /api/notifications/settings`
- `GET    /api/notifications/notifications`
- `GET    /api/notifications/push`
- `POST   /api/notifications/push/subscribe`
- `POST   /api/notifications/push/unsubscribe`
- `POST   /api/notifications/push/test`
- `GET    /api/notifications/telegram`
- `GET    /api/notifications/telegram`
- `POST   /api/notifications/telegram/connect`
- `DELETE /api/notifications/telegram/connect`
- `DELETE /api/notifications/telegram/chats/:chatId`
- `GET    /api/notifications/ntfy`
- `GET    /api/notifications/ntfy`
- `PUT    /api/notifications/ntfy`
- `GET    /api/notifications/ntfy`
- `DELETE /api/notifications/ntfy`
- `POST   /api/notifications/ntfy/test`

## /api/preview

- `POST   /api/preview/tunnel`
- `DELETE /api/preview/tunnel/:port{[0-9]+}`
- `GET    /api/preview/tunnels`

## /api/projects

- `GET    /api/projects`
- `POST   /api/projects`
- `GET    /api/projects/suggest-dirs`
- `GET    /api/projects/last-clone-dir`
- `POST   /api/projects/git/clone`
- `PATCH  /api/projects/reorder`
- `GET    /api/projects/projects`
- `PATCH  /api/projects/:name/color`
- `GET    /api/projects/projects`
- `POST   /api/projects/:name/image`
- `GET    /api/projects/projects`
- `GET    /api/projects/file`
- `DELETE /api/projects/:name/image`
- `GET    /api/projects/projects`
- `GET    /api/projects/:name/image`
- `GET    /api/projects/projects`
- `GET    /api/projects/:name/settings`
- `GET    /api/projects/projects`
- `PATCH  /api/projects/:name/settings`
- `GET    /api/projects/projects`
- `PATCH  /api/projects/:name`
- `DELETE /api/projects/:name`

## /api/remote-desktop

- `GET    /api/remote-desktop/auth`
- `GET    /api/remote-desktop/capabilities`
- `GET    /api/remote-desktop/auth`
- `GET    /api/remote-desktop/requirements/ffmpeg/install`
- `POST   /api/remote-desktop/requirements/ffmpeg/install`
- `POST   /api/remote-desktop/requirements/:id/:action`
- `POST   /api/remote-desktop/session`
- `POST   /api/remote-desktop/whep/:ticket`
- `GET    /api/remote-desktop/relay`
- `POST   /api/remote-desktop/relay/install`
- `POST   /api/remote-desktop/relay/uninstall`

## /api/schedules

- `GET    /api/schedules`
- `GET    /api/schedules/:id{[0-9]+}`
- `POST   /api/schedules`
- `GET    /api/schedules/ai`
- `PATCH  /api/schedules/:id{[0-9]+}`
- `DELETE /api/schedules/:id{[0-9]+}`
- `POST   /api/schedules/:id{[0-9]+}/run-now`
- `GET    /api/schedules/:id{[0-9]+}/runs`

## /api/settings

- `PUT    /api/settings/device-name`
- `GET    /api/settings/theme`
- `GET    /api/settings/theme`
- `PUT    /api/settings/theme`
- `GET    /api/settings/ui-prefs`
- `PUT    /api/settings/ui-prefs`
- `GET    /api/settings/ai`
- `GET    /api/settings/ai`
- `PUT    /api/settings/ai`
- `GET    /api/settings/ai`
- `GET    /api/settings/ai/providers/status`
- `POST   /api/settings/ai/providers/:id/probe`
- `GET    /api/settings/ai/providers/:id/models`
- `GET    /api/settings/keybindings`
- `PUT    /api/settings/keybindings`
- `GET    /api/settings/telegram`
- `GET    /api/settings/telegram`
- `PUT    /api/settings/telegram`
- `GET    /api/settings/telegram`
- `POST   /api/settings/telegram/test`
- `GET    /api/settings/telegram`
- `PUT    /api/settings/auth/password`
- `GET    /api/settings/auth`
- `GET    /api/settings/port`
- `GET    /api/settings/proxy`
- `PUT    /api/settings/proxy`
- `GET    /api/settings/query_audit`
- `GET    /api/settings/query-audit`
- `PUT    /api/settings/query-audit`
- `GET    /api/settings/query_audit`
- `DELETE /api/settings/query-audit/logs`
- `GET    /api/settings/clawbot`
- `GET    /api/settings/clawbot`
- `PUT    /api/settings/clawbot`
- `GET    /api/settings/clawbot`
- `GET    /api/settings/clawbot/paired`
- `DELETE /api/settings/clawbot/paired/:chatId`
- `GET    /api/settings/clawbot/telegram`
- `GET    /api/settings/telegram`
- `GET    /api/settings/clawbot`
- `PUT    /api/settings/clawbot/telegram`
- `GET    /api/settings/clawbot`
- `POST   /api/settings/clawbot/telegram/connect`
- `DELETE /api/settings/clawbot/telegram/connect`
- `GET    /api/settings/clawbot/memories`
- `DELETE /api/settings/clawbot/memories/:id`
- `GET    /api/settings/files`
- `PATCH  /api/settings/files`
- `GET    /api/settings/clawbot/tasks`

## /api/settings/design

- `GET    /api/settings/design/projects`
- `GET    /api/settings/design`
- `PUT    /api/settings/design`
- `POST   /api/settings/design/skill`

## /api/settings/mcp

- `GET    /api/settings/mcp`
- `GET    /api/settings/mcp/import/preview`
- `POST   /api/settings/mcp/import`
- `GET    /api/settings/mcp/:name`
- `POST   /api/settings/mcp`
- `PUT    /api/settings/mcp/:name`
- `DELETE /api/settings/mcp/:name`

## /api/settings/themes

- `GET    /api/settings/themes`
- `POST   /api/settings/themes`
- `DELETE /api/settings/themes/:id`
- `PATCH  /api/settings/themes/:id`

## /api/speech

- `GET    /api/speech/status`
- `POST   /api/speech/install`
- `POST   /api/speech/uninstall`
- `POST   /api/speech/transcribe`

## /api/system

- `GET    /api/system/hardware`
- `GET    /api/system/app-icon/:id`
- `GET    /api/system/resources`
- `GET    /api/system/resources/stream`
- `POST   /api/system/resources/stream/:sid/ping`
- `DELETE /api/system/resources/stream/:sid`
- `GET    /api/system/resources/process/:pid`
- `POST   /api/system/resources/signal`
- `POST   /api/system/resources/kill`
- `GET    /api/system/services`
- `GET    /api/system/services/:scope/:unit`
- `POST   /api/system/services/:scope/:unit/:action`
- `GET    /api/system/host`

## /api/tailscale

- `GET    /api/tailscale/auth`
- `GET    /api/tailscale/state`
- `POST   /api/tailscale/login`
- `POST   /api/tailscale/login/cancel`
- `POST   /api/tailscale/service`

## /api/teams

- `GET    /api/teams`
- `GET    /api/teams/:name`
- `GET    /api/teams/:name/activity`
- `GET    /api/teams/:name/members/:member/transcript`
- `DELETE /api/teams/:name`

## /api/trace

- `POST   /api/trace`
- `GET    /api/trace/sessions/:sessionId`

## /api/tunnel

- `GET    /api/tunnel`
- `GET    /api/tunnel/port`
- `POST   /api/tunnel/enabled`
- `GET    /api/tunnel/tunnel`
- `POST   /api/tunnel/start`
- `GET    /api/tunnel/port`
- `POST   /api/tunnel/stop`

## /api/tunnel/named

- `GET    /api/tunnel/named/auth`
- `GET    /api/tunnel/named/status`
- `GET    /api/tunnel/named/tunnel`
- `GET    /api/tunnel/named/auth`
- `POST   /api/tunnel/named/dismiss`
- `GET    /api/tunnel/named/tunnel`
- `GET    /api/tunnel/named/zone`
- `POST   /api/tunnel/named/login`
- `POST   /api/tunnel/named/login/cancel`
- `POST   /api/tunnel/named/setup`
- `POST   /api/tunnel/named/disable`

## /api/tunnels

- `GET    /api/tunnels`
- `GET    /api/tunnels/transports`
- `POST   /api/tunnels/frame-ancestors`
- `POST   /api/tunnels`
- `DELETE /api/tunnels/:pid{[0-9]+}`

## /api/upgrade

- `GET    /api/upgrade`
- `POST   /api/upgrade/apply`

## /proxy

- `POST   /proxy/v1/messages`
- `POST   /proxy/v1/chat/completions`
- `POST   /proxy/v1/messages/count_tokens`
- `POST   /proxy/:provider/v1/messages`
- `POST   /proxy/:provider/v1/chat/completions`
- `POST   /proxy/:provider/v1/images/generations`
- `POST   /proxy/:provider/v1/images/edits`
- `GET    /proxy/:provider/v1/models`
- `GET    /proxy/stats`

## WebSocket

- `ws://<host>/ws/chat` — AI chat stream (Claude Agent SDK)
- `ws://<host>/ws/terminal` — PTY terminal multiplexer
- `ws://<host>/ws/extensions` — extension host channel

<!-- Generated from src/server/routes/ for PPM v0.23.13 -->
