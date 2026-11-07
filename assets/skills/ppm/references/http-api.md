# PPM HTTP API

_Auto-generated. Do not edit._

_Base URL: `http://localhost:<port>` — `port` in `ppm status --json` (8080 unless configured otherwise)._

## Authentication

With auth on (the default), `/api/*` needs `Authorization: Bearer <token>` (`GET /api/health` and `GET /api/info`
answer without one), and a WebSocket takes it as `?token=<token>`. The token is the access password the user
signs in to PPM with; `GET /api/auth/check` answers 200 when it is right.
`ppm config get auth.token` deliberately does not print it: ask the user for it rather than digging it out of
the config database, or use the CLI, which needs no token.

JSON responses are wrapped: `{ "ok": true, "data": … }` or `{ "ok": false, "error": "…" }`.

## /

- `GET    *`

## /api

- `GET    /api/health`
- `GET    /api/info`
- `GET    /api/logs/recent`
- `GET    /api/mcp-auth/callback`
- `ALL    /api/design-mcp`
- `ALL    /api/tab-tools-mcp`
- `GET    /api/auth/check`
- `GET    /api/system/event-loop`

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

- `GET    /api/android/capabilities`
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
- `GET    /api/android/projects/:project/apks`
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
- `POST   /api/cloud/login`
- `POST   /api/cloud/logout`
- `POST   /api/cloud/link`
- `POST   /api/cloud/unlink`
- `GET    /api/cloud/alias`
- `PATCH  /api/cloud/alias`
- `GET    /api/cloud/login-url`

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
- `POST   /api/db/ai-approvals/:requestId`
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

## /api/db/connections

- `POST   /api/db/connections/:id/grid`
- `POST   /api/db/connections/:id/grid/count`
- `POST   /api/db/connections/:id/grid/values`
- `POST   /api/db/connections/:id/grid/export`
- `POST   /api/db/connections/:id/grid/cell`
- `POST   /api/db/connections/:id/changeset/preview`
- `POST   /api/db/connections/:id/changeset/apply`
- `GET    /api/db/connections/:id/databases`
- `GET    /api/db/connections/:id/objects`
- `GET    /api/db/connections/:id/columns`
- `GET    /api/db/connections/:id/structure`
- `GET    /api/db/connections/:id/object-sql`
- `POST   /api/db/connections/:id/structure/preview`
- `POST   /api/db/connections/:id/structure/apply`
- `POST   /api/db/connections/:id/impexp/export`
- `POST   /api/db/connections/:id/impexp/import`
- `POST   /api/db/connections/:id/query/script`
- `POST   /api/db/connections/:id/query/cancel`
- `GET    /api/db/connections/:id/history`

## /api/db/drivers

- `GET    /api/db/drivers`
- `POST   /api/db/drivers/:id/install`
- `DELETE /api/db/drivers/:id`

## /api/db/grid-export

- `GET    /api/db/grid-export/:ticket`

## /api/db/impexp

- `PUT    /api/db/impexp/uploads`
- `POST   /api/db/impexp/uploads/:id/preview`
- `DELETE /api/db/impexp/uploads/:id`
- `GET    /api/db/impexp/jobs/:id`
- `POST   /api/db/impexp/jobs/:id/stop`
- `POST   /api/db/impexp/jobs/:id/download`

## /api/design-shares

- `GET    /api/design-shares/address`

## /api/extensions

- `GET    /api/extensions`
- `GET    /api/extensions/contributions`
- `GET    /api/extensions/:id{.+}`
- `POST   /api/extensions/install`
- `POST   /api/extensions/dev-link`
- `DELETE /api/extensions/:id{.+}`
- `PATCH  /api/extensions/:id{.+}`

## /api/feature-intros

- `GET    /api/feature-intros`
- `POST   /api/feature-intros/:id/answer`
- `POST   /api/feature-intros/:id/skip`
- `POST   /api/feature-intros/:id/seen-in-settings`

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
- `GET    /api/fs/xlsx-sheet`
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

## /api/jira

- `GET    /api/jira/watchers`
- `POST   /api/jira/watchers`
- `PUT    /api/jira/watchers/:id`
- `DELETE /api/jira/watchers/:id`
- `POST   /api/jira/watchers/test-jql`
- `POST   /api/jira/watchers/:id/pull`
- `POST   /api/jira/watchers/pull-all`
- `POST   /api/jira/results/:id/debug`
- `POST   /api/jira/results/:id/resume`
- `POST   /api/jira/results/:id/cancel`
- `PATCH  /api/jira/results/:id/read`
- `GET    /api/jira/results/unread-count`
- `GET    /api/jira/results`
- `GET    /api/jira/results/stats`
- `GET    /api/jira/results/:id`
- `DELETE /api/jira/results/:id`
- `POST   /api/jira/results/manual`
- `GET    /api/jira/search/:configId`
- `GET    /api/jira/ticket/:configId/:issueKey`
- `PUT    /api/jira/ticket/:configId/:issueKey`
- `GET    /api/jira/ticket/:configId/:issueKey/transitions`
- `POST   /api/jira/ticket/:configId/:issueKey/transition`
- `GET    /api/jira/metadata/:configId/projects`
- `GET    /api/jira/metadata/:configId/assignees`
- `GET    /api/jira/metadata/:configId/:field`

## /api/jira/config

- `GET    /api/jira/config/projects`
- `GET    /api/jira/config`
- `GET    /api/jira/config/:projectId`
- `PUT    /api/jira/config/:projectId`
- `DELETE /api/jira/config/:projectId`
- `POST   /api/jira/config/:projectId/test`

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

## /api/notifications

- `GET    /api/notifications/settings`
- `PUT    /api/notifications/settings`
- `GET    /api/notifications/push`
- `POST   /api/notifications/push/subscribe`
- `POST   /api/notifications/push/unsubscribe`
- `POST   /api/notifications/push/test`
- `GET    /api/notifications/telegram`
- `POST   /api/notifications/telegram/connect`
- `DELETE /api/notifications/telegram/connect`
- `DELETE /api/notifications/telegram/chats/:chatId`
- `GET    /api/notifications/ntfy`
- `PUT    /api/notifications/ntfy`
- `DELETE /api/notifications/ntfy`
- `POST   /api/notifications/ntfy/test`

## /api/preview

- `POST   /api/preview/tunnel`
- `DELETE /api/preview/tunnel/:port{[0-9]+}`
- `GET    /api/preview/tunnels`

## /api/project/:projectName/chat

- `GET    /api/project/:projectName/chat/slash-items`
- `DELETE /api/project/:projectName/chat/slash-items/cache`
- `POST   /api/project/:projectName/chat/slash-recents`
- `GET    /api/project/:projectName/chat/usage`
- `GET    /api/project/:projectName/chat/providers`
- `GET    /api/project/:projectName/chat/providers/:providerId/models`
- `GET    /api/project/:projectName/chat/providers/:providerId/effort-status`
- `GET    /api/project/:projectName/chat/sessions`
- `GET    /api/project/:projectName/chat/search`
- `GET    /api/project/:projectName/chat/sessions/:id/design`
- `GET    /api/project/:projectName/chat/sessions/:id/messages`
- `POST   /api/project/:projectName/chat/prewarm`
- `POST   /api/project/:projectName/chat/sessions`
- `DELETE /api/project/:projectName/chat/sessions`
- `DELETE /api/project/:projectName/chat/sessions/:id`
- `PATCH  /api/project/:projectName/chat/sessions/:id`
- `PUT    /api/project/:projectName/chat/sessions/:id/account`
- `PUT    /api/project/:projectName/chat/sessions/:id/pin`
- `DELETE /api/project/:projectName/chat/sessions/:id/pin`
- `GET    /api/project/:projectName/chat/sessions/unread`
- `GET    /api/project/:projectName/chat/sessions/running`
- `POST   /api/project/:projectName/chat/sessions/:id/read`
- `POST   /api/project/:projectName/chat/sessions/:id/unread`
- `PATCH  /api/project/:projectName/chat/sessions/bulk-tag`
- `PATCH  /api/project/:projectName/chat/sessions/:id/tag`
- `DELETE /api/project/:projectName/chat/sessions/:id/tag`
- `POST   /api/project/:projectName/chat/sessions/:id/fork`
- `GET    /api/project/:projectName/chat/sessions/:id/logs`
- `GET    /api/project/:projectName/chat/sessions/:id/debug`
- `GET    /api/project/:projectName/chat/sessions/:id/usage`
- `GET    /api/project/:projectName/chat/sessions/:id/images`
- `POST   /api/project/:projectName/chat/sessions/:id/images/strip`
- `GET    /api/project/:projectName/chat/sessions/:id/tasks`
- `GET    /api/project/:projectName/chat/pre-compact-messages`
- `POST   /api/project/:projectName/chat/upload`
- `DELETE /api/project/:projectName/chat/uploads/:filename`
- `GET    /api/project/:projectName/chat/uploads/:filename`
- `GET    /api/project/:projectName/chat/drafts/:sessionId`
- `PUT    /api/project/:projectName/chat/drafts/:sessionId`
- `DELETE /api/project/:projectName/chat/drafts/:sessionId`
- `POST   /api/project/:projectName/chat/sessions/:id/file-changes`
- `GET    /api/project/:projectName/chat/sessions/:id/file-changes/count`
- `POST   /api/project/:projectName/chat/sessions/:id/file-changes/reviewed`
- `POST   /api/project/:projectName/chat/sessions/:id/file-changes/answer`
- `POST   /api/project/:projectName/chat/sessions/:id/file-changes/undo`
- `POST   /api/project/:projectName/chat/sessions/:id/file-changes/revert-turn`
- `GET    /api/project/:projectName/chat/sessions/:id/file-changes/diff`

## /api/project/:projectName/chat/prepare

- `POST   /api/project/:projectName/chat/prepare`

## /api/project/:projectName/designs

- `GET    /api/project/:projectName/designs`
- `POST   /api/project/:projectName/designs`
- `GET    /api/project/:projectName/designs/:slug`
- `PATCH  /api/project/:projectName/designs/:slug`
- `DELETE /api/project/:projectName/designs/:slug`
- `GET    /api/project/:projectName/designs/:slug/history`
- `POST   /api/project/:projectName/designs/:slug/history/:id/restore`

## /api/project/:projectName/designs/:slug/check

- `POST   /api/project/:projectName/designs/:slug/check/:requestId`

## /api/project/:projectName/designs/:slug/comments

- `GET    /api/project/:projectName/designs/:slug/comments`
- `POST   /api/project/:projectName/designs/:slug/comments`
- `POST   /api/project/:projectName/designs/:slug/comments/context`
- `PATCH  /api/project/:projectName/designs/:slug/comments/:id`
- `DELETE /api/project/:projectName/designs/:slug/comments/:id`
- `POST   /api/project/:projectName/designs/:slug/comments/:id/replies`
- `PATCH  /api/project/:projectName/designs/:slug/comments/:id/replies/:replyId`
- `DELETE /api/project/:projectName/designs/:slug/comments/:id/replies/:replyId`

## /api/project/:projectName/designs/:slug/export

- `GET    /api/project/:projectName/designs/:slug/export/zip`
- `GET    /api/project/:projectName/designs/:slug/export/html`

## /api/project/:projectName/designs/:slug/shares

- `GET    /api/project/:projectName/designs/:slug/shares`
- `POST   /api/project/:projectName/designs/:slug/shares`
- `GET    /api/project/:projectName/designs/:slug/shares/:id/changes`
- `PATCH  /api/project/:projectName/designs/:slug/shares/:id`
- `DELETE /api/project/:projectName/designs/:slug/shares/:id/comments`
- `DELETE /api/project/:projectName/designs/:slug/shares/:id`

## /api/project/:projectName/designs/:slug/style

- `POST   /api/project/:projectName/designs/:slug/style`

## /api/project/:projectName/designs/:slug/tweaks

- `GET    /api/project/:projectName/designs/:slug/tweaks`
- `POST   /api/project/:projectName/designs/:slug/tweaks`

## /api/project/:projectName/designs/:slug/undo

- `POST   /api/project/:projectName/designs/:slug/undo`

## /api/project/:projectName/designs/systems

- `GET    /api/project/:projectName/designs/systems`
- `POST   /api/project/:projectName/designs/systems`
- `GET    /api/project/:projectName/designs/systems/:id`
- `PATCH  /api/project/:projectName/designs/systems/:id`
- `DELETE /api/project/:projectName/designs/systems/:id`
- `GET    /api/project/:projectName/designs/systems/:id/stale`
- `POST   /api/project/:projectName/designs/systems/:id/showcase`

## /api/project/:projectName/files

- `GET    /api/project/:projectName/files/list`
- `POST   /api/project/:projectName/files/list-batch`
- `GET    /api/project/:projectName/files/index`
- `GET    /api/project/:projectName/files/index/search`
- `GET    /api/project/:projectName/files/tree`
- `GET    /api/project/:projectName/files/raw`
- `GET    /api/project/:projectName/files/probe`
- `GET    /api/project/:projectName/files/transcode`
- `DELETE /api/project/:projectName/files/transcode`
- `GET    /api/project/:projectName/files/docx-html`
- `GET    /api/project/:projectName/files/xlsx-sheet`
- `GET    /api/project/:projectName/files/read`
- `PUT    /api/project/:projectName/files/write`
- `POST   /api/project/:projectName/files/create`
- `POST   /api/project/:projectName/files/upload`
- `DELETE /api/project/:projectName/files/delete`
- `GET    /api/project/:projectName/files/compare`
- `POST   /api/project/:projectName/files/rename`
- `GET    /api/project/:projectName/files/resolve`
- `GET    /api/project/:projectName/files/search`
- `POST   /api/project/:projectName/files/move`
- `POST   /api/project/:projectName/files/copy`

## /api/project/:projectName/files/download

- `POST   /api/project/:projectName/files/download/token`
- `GET    /api/project/:projectName/files/download/zip`

## /api/project/:projectName/git

- `GET    /api/project/:projectName/git/repos`
- `GET    /api/project/:projectName/git/status`
- `GET    /api/project/:projectName/git/changes`
- `GET    /api/project/:projectName/git/changes/file`
- `GET    /api/project/:projectName/git/commit-draft`
- `PUT    /api/project/:projectName/git/commit-draft`
- `GET    /api/project/:projectName/git/discards`
- `POST   /api/project/:projectName/git/discard/undo`
- `GET    /api/project/:projectName/git/diff`
- `GET    /api/project/:projectName/git/diff-stat`
- `GET    /api/project/:projectName/git/branch-diff`
- `GET    /api/project/:projectName/git/file-diff`
- `GET    /api/project/:projectName/git/file-full-diff`
- `GET    /api/project/:projectName/git/file-blob`
- `GET    /api/project/:projectName/git/graph`
- `GET    /api/project/:projectName/git/branches`
- `GET    /api/project/:projectName/git/refs`
- `GET    /api/project/:projectName/git/pr-url`
- `POST   /api/project/:projectName/git/fetch`
- `POST   /api/project/:projectName/git/discard`
- `POST   /api/project/:projectName/git/stage`
- `POST   /api/project/:projectName/git/unstage`
- `GET    /api/project/:projectName/git/blame`
- `GET    /api/project/:projectName/git/commit-line`
- `GET    /api/project/:projectName/git/hunks`
- `POST   /api/project/:projectName/git/stage-hunks`
- `POST   /api/project/:projectName/git/unstage-hunks`
- `POST   /api/project/:projectName/git/discard-hunks`
- `POST   /api/project/:projectName/git/commit`
- `POST   /api/project/:projectName/git/push`
- `POST   /api/project/:projectName/git/pull`
- `POST   /api/project/:projectName/git/publish`
- `POST   /api/project/:projectName/git/commit/undo`
- `POST   /api/project/:projectName/git/operation/:action{abort|continue}`
- `GET    /api/project/:projectName/git/stashes`
- `POST   /api/project/:projectName/git/stash`
- `POST   /api/project/:projectName/git/stash/${action}`
- `POST   /api/project/:projectName/git/branch/create`
- `POST   /api/project/:projectName/git/checkout`
- `POST   /api/project/:projectName/git/branch/delete`
- `POST   /api/project/:projectName/git/merge`
- `POST   /api/project/:projectName/git/cherry-pick`
- `POST   /api/project/:projectName/git/revert`
- `POST   /api/project/:projectName/git/tag`
- `GET    /api/project/:projectName/git/worktrees`
- `POST   /api/project/:projectName/git/worktree/add`
- `POST   /api/project/:projectName/git/worktree/remove`
- `POST   /api/project/:projectName/git/worktree/prune`

## /api/project/:projectName/lsp

- `GET    /api/project/:projectName/lsp/status`
- `POST   /api/project/:projectName/lsp/install`

## /api/project/:projectName/tags

- `GET    /api/project/:projectName/tags`
- `POST   /api/project/:projectName/tags`
- `PATCH  /api/project/:projectName/tags/default-tag`
- `POST   /api/project/:projectName/tags/reset`
- `PATCH  /api/project/:projectName/tags/:id`
- `DELETE /api/project/:projectName/tags/:id`

## /api/project/:projectName/workspace

- `GET    /api/project/:projectName/workspace`
- `PUT    /api/project/:projectName/workspace`

## /api/projects

- `GET    /api/projects`
- `POST   /api/projects`
- `GET    /api/projects/suggest-dirs`
- `GET    /api/projects/last-clone-dir`
- `POST   /api/projects/git/clone`
- `PATCH  /api/projects/reorder`
- `PATCH  /api/projects/:name/color`
- `POST   /api/projects/:name/image`
- `DELETE /api/projects/:name/image`
- `GET    /api/projects/:name/image`
- `GET    /api/projects/:name/settings`
- `PATCH  /api/projects/:name/settings`
- `PATCH  /api/projects/:name`
- `DELETE /api/projects/:name`

## /api/remote-desktop

- `GET    /api/remote-desktop/capabilities`
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
- `PATCH  /api/schedules/:id{[0-9]+}`
- `DELETE /api/schedules/:id{[0-9]+}`
- `POST   /api/schedules/:id{[0-9]+}/run-now`
- `GET    /api/schedules/:id{[0-9]+}/runs`
- `GET    /api/schedules/:id{[0-9]+}/logs`
- `GET    /api/schedules/:id{[0-9]+}/state`
- `PUT    /api/schedules/:id{[0-9]+}/state`
- `GET    /api/schedules/:id{[0-9]+}/export`
- `POST   /api/schedules/import`

## /api/sessions-collab

- `POST   /api/sessions-collab/approvals/:requestId`
- `GET    /api/sessions-collab/sessions/:id/links`
- `GET    /api/sessions-collab/projectPath`
- `POST   /api/sessions-collab/sessions/:id/stop-children`
- `GET    /api/sessions-collab/projectPath`

## /api/settings

- `PUT    /api/settings/device-name`
- `GET    /api/settings/theme`
- `PUT    /api/settings/theme`
- `GET    /api/settings/ui-prefs`
- `PUT    /api/settings/ui-prefs`
- `GET    /api/settings/ai`
- `PUT    /api/settings/ai`
- `GET    /api/settings/ai/providers/status`
- `POST   /api/settings/ai/providers/:id/probe`
- `GET    /api/settings/ai/providers/:id/models`
- `GET    /api/settings/ai/providers/:id/effort-status`
- `GET    /api/settings/keybindings`
- `PUT    /api/settings/keybindings`
- `GET    /api/settings/telegram`
- `PUT    /api/settings/telegram`
- `POST   /api/settings/telegram/test`
- `PUT    /api/settings/auth/password`
- `GET    /api/settings/proxy`
- `PUT    /api/settings/proxy`
- `GET    /api/settings/query-audit`
- `PUT    /api/settings/query-audit`
- `DELETE /api/settings/query-audit/logs`
- `GET    /api/settings/storage`
- `PUT    /api/settings/session-trace`
- `GET    /api/settings/session_trace`
- `GET    /api/settings/clawbot`
- `PUT    /api/settings/clawbot`
- `GET    /api/settings/clawbot/paired`
- `DELETE /api/settings/clawbot/paired/:chatId`
- `GET    /api/settings/clawbot/telegram`
- `PUT    /api/settings/clawbot/telegram`
- `POST   /api/settings/clawbot/telegram/connect`
- `DELETE /api/settings/clawbot/telegram/connect`
- `GET    /api/settings/clawbot/memories`
- `DELETE /api/settings/clawbot/memories/:id`
- `GET    /api/settings/files`
- `PATCH  /api/settings/files`
- `GET    /api/settings/clawbot/tasks`

## /api/settings/design

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

## /api/share-host

- `GET    /api/share-host/status`
- `GET    /api/share-host/zone`
- `POST   /api/share-host/enabled`
- `POST   /api/share-host/quick`
- `POST   /api/share-host/setup`

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
- `POST   /api/tunnel/enabled`
- `POST   /api/tunnel/start`
- `POST   /api/tunnel/stop`

## /api/tunnel/named

- `GET    /api/tunnel/named/status`
- `POST   /api/tunnel/named/dismiss`
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

## /s

- `GET    /s/:code/info`
- `GET    /s/:code`
- `ALL    /s`
- `ALL    /s/*`

## WebSocket

Authenticate with `?token=<token>` (see Authentication).

- `/ws/health`
- `/ws/global`
- `/ws/extensions`
- `/ws/remote-desktop`
- `/ws/android`
- `/ws/project/<project>/<type>/<id>` — `<type>`: `terminal`, `chat`, `group`, `lsp` (for `chat`, `<id>` is the session id)

<!-- Generated from src/server/routes/ for PPM v0.23.37 -->
