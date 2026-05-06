# PPM HTTP API

_Auto-generated. Do not edit._

_Base URL: `http://localhost:8080` (default; override via `ppm config set port <n>`)._

## /

- `GET    *`

## /api/accounts

- `GET    /api/accounts`
- `GET    /api/accounts/active`
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

## /api/cloud

- `GET    /api/cloud/status`
- `GET    /api/cloud/cloud_url`
- `POST   /api/cloud/login`
- `GET    /api/cloud/cloud_url`
- `POST   /api/cloud/logout`
- `POST   /api/cloud/link`
- `POST   /api/cloud/unlink`
- `GET    /api/cloud/login-url`
- `GET    /api/cloud/cloud_url`

## /api/db

- `GET    /api/db/connections`
- `GET    /api/db/connections/export`
- `POST   /api/db/connections/import`
- `GET    /api/db/connections/:id`
- `POST   /api/db/connections`
- `PUT    /api/db/connections/:id`
- `DELETE /api/db/connections/:id`
- `POST   /api/db/test`
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
- `GET    /api/fs/raw`
- `DELETE /api/fs/rmdir`
- `POST   /api/fs/mkdir`
- `PUT    /api/fs/write`

## /api/postgres

- `POST   /api/postgres/test`
- `POST   /api/postgres/tables`
- `POST   /api/postgres/schema`
- `POST   /api/postgres/data`
- `POST   /api/postgres/query`
- `POST   /api/postgres/cell`

## /api/preview

- `POST   /api/preview/tunnel`
- `DELETE /api/preview/tunnel/:port{[0-9]+}`
- `GET    /api/preview/tunnels`

## /api/projects

- `GET    /api/projects`
- `POST   /api/projects`
- `GET    /api/projects/suggest-dirs`
- `PATCH  /api/projects/reorder`
- `GET    /api/projects/projects`
- `PATCH  /api/projects/:name/color`
- `GET    /api/projects/projects`
- `GET    /api/projects/:name/settings`
- `GET    /api/projects/projects`
- `PATCH  /api/projects/:name/settings`
- `GET    /api/projects/projects`
- `PATCH  /api/projects/:name`
- `DELETE /api/projects/:name`

## /api/push

- `GET    /api/push/vapid-key`
- `POST   /api/push/subscribe`
- `DELETE /api/push/subscribe`

## /api/settings

- `PUT    /api/settings/device-name`
- `GET    /api/settings/theme`
- `GET    /api/settings/theme`
- `PUT    /api/settings/theme`
- `GET    /api/settings/ai`
- `GET    /api/settings/ai`
- `PUT    /api/settings/ai`
- `GET    /api/settings/ai`
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
- `GET    /api/settings/clawbot`
- `GET    /api/settings/clawbot`
- `PUT    /api/settings/clawbot`
- `GET    /api/settings/clawbot`
- `GET    /api/settings/clawbot/paired`
- `POST   /api/settings/clawbot/paired/approve`
- `DELETE /api/settings/clawbot/paired/:chatId`
- `GET    /api/settings/clawbot/memories`
- `DELETE /api/settings/clawbot/memories/:id`
- `GET    /api/settings/files`
- `PATCH  /api/settings/files`
- `GET    /api/settings/clawbot/tasks`

## /api/settings/mcp

- `GET    /api/settings/mcp`
- `GET    /api/settings/mcp/import/preview`
- `POST   /api/settings/mcp/import`
- `GET    /api/settings/mcp/:name`
- `POST   /api/settings/mcp`
- `PUT    /api/settings/mcp/:name`
- `DELETE /api/settings/mcp/:name`

## /api/system

- `GET    /api/system/resources`
- `GET    /api/system/resources/history`
- `POST   /api/system/resources/kill/:pid`
- `GET    /api/system/resources/stream`

## /api/teams

- `GET    /api/teams`
- `GET    /api/teams/:name`
- `DELETE /api/teams/:name`

## /api/tunnel

- `GET    /api/tunnel`
- `GET    /api/tunnel/port`
- `POST   /api/tunnel/start`
- `GET    /api/tunnel/port`
- `POST   /api/tunnel/stop`

## /api/upgrade

- `GET    /api/upgrade`
- `POST   /api/upgrade/apply`

## /proxy

- `POST   /proxy/v1/messages`
- `POST   /proxy/v1/chat/completions`
- `POST   /proxy/v1/messages/count_tokens`

## WebSocket

- `ws://<host>/ws/chat` — AI chat stream (Claude Agent SDK)
- `ws://<host>/ws/terminal` — PTY terminal multiplexer
- `ws://<host>/ws/extensions` — extension host channel

<!-- Generated from src/server/routes/ for PPM v0.13.12 -->
