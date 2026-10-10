# Integrations (Telegram, Jira)

> Part of the [PPM system architecture](../system-architecture.md).

## Telegram

PPM uses Telegram in two unrelated ways, each with **its own bot**:

- **Notifications** send through `config.telegram` to the chats in the `telegram_notify_chats` row
  (`src/services/telegram-notification.service.ts`). See `notification.service.ts`.
- **PPM Assistant on Telegram**: a connected private chat is a second window onto one PPM Assistant
  session. Design, rules and limitations: [PPM Assistant → Telegram](ppm-assistant.md#telegram).

They used to share one bot, so a chat connected for alerts could command the AI. The bots and their
chat lists are now separate (`src/services/telegram-bots.ts`): the Assistant reads the bot in the
`ppmbot_telegram` row and answers the chats approved in `clawbot_paired_chats`. An install that
shared them is split once, on first read. Both go through one Bot API client
(`src/services/telegram/`), and the one-tap Connect link is `telegram-connect.service.ts`.

**Why the names still say PPMBot and ClawBot.** The Assistant replaced PPMBot, which had replaced
ClawBot, and neither rename touched stored data: the config key `clawbot` (typed `PPMBotConfig`, now
only `enabled`, `show_tool_calls`, `debounce_ms`), the `ppmbot_telegram` row, the `clawbot_*`
tables and the `/api/settings/clawbot*` routes all configure the Assistant's Telegram side. Renaming
them would only force everyone to reconnect. Treat them as key names, not as subsystems. PPMBot's
coordinator, its `ppm bot` CLI and its `bot_tasks` delegation no longer exist; their tables are
left in place, unused.

---

## Jira Watcher Auto-Debug Service
**Component:** Jira Cloud REST API poller + direct Claude debug session orchestrator

**Responsibilities:**
- Poll Jira Cloud per-project on configurable interval (30s–60m)
- Match issues via JQL filters (status, project key, priority, etc.)
- Auto-queue or manually trigger direct Claude debug sessions (no bot_task middleman)
- Manage concurrency: max 2 concurrent, max 1 per project
- Track results (pending/queued/running/done/failed) with unread status
- Notify via WS toast + Telegram when analysis completes
- Rate-limit aware (tracks Jira API quota, auto-backoff 429 responses)

**Architecture:**
```
Jira Cloud API ← JiraWatcherService (poller, 30s–60m intervals per watcher)
                 ├─ searchIssues(jql) → issue list
                 ├─ insertResult() → SQLite jira_watch_results
                 └─ jiraDebugService.enqueue() → concurrency queue

JiraDebugSessionService (concurrency queue processor)
 ├─ enqueue(resultId, promptOverride?) → validate + queue
 ├─ processQueue() — respects MAX_CONCURRENT=2, MAX_PER_PROJECT=1
 ├─ runDebugSession()
 │   ├─ chatService.createSession(projectPath) — new isolated session
 │   ├─ chatService.sendMessage(prompt) — send with bypassPermissions
 │   ├─ capture lastAssistantText (max 500 chars)
 │   └─ updateResultStatus() + notificationService.broadcastWs("jira:debug_complete")
 └─ cancelDebug(resultId) — abort running session
```

**Services (src/services/):**
- **JiraConfigService** — Config CRUD, AES-256 token encryption/decryption, per-project setup
- **JiraWatcherDbService** — Watchers + results table queries, enabled/disabled toggle, last polled tracking
- **JiraApiClient** — Jira Cloud REST v3 (search, getIssue, transitions, test connection), rate limit state, backoff logic
- **JiraWatcherService** — Main poller, timer management (startAll, startWatcher, stopWatcher, pollWatcher), prompt templating, session enqueueing
- **JiraDebugSessionService** — Concurrency queue, session lifecycle, timeout management, abort handling

**Database Schema (v19):**
- `jira_config` — id, project_id (FK), base_url, email, api_token_encrypted, created_at
- `jira_watchers` — id, jira_config_id (FK), name, jql, prompt_template, enabled, mode ("debug"|"notify"), interval_ms, last_polled_at, created_at
- `jira_watch_results` — id, watcher_id, issue_key, issue_summary, issue_updated, session_id (FK chat_sessions.id), status ("pending"|"queued"|"running"|"done"|"failed"), ai_summary, source ("watcher"|"manual"), triggered_by ("auto"|"manual"), read_at (nullable), deleted, created_at

**API Routes (src/server/routes/jira*.ts):**
```
POST   /api/jira/config                    — Create/update config (baseUrl, email, token)
GET    /api/jira/config                    — Get config for active project
DELETE /api/jira/config                    — Delete config
POST   /api/jira/config/test               — Test Jira connection
GET    /api/jira/watchers                  — List watchers for config
POST   /api/jira/watchers                  — Create watcher (name, jql, mode, interval)
PATCH  /api/jira/watchers/:id              — Update watcher
DELETE /api/jira/watchers/:id              — Delete watcher (soft delete results)
POST   /api/jira/watchers/:id/enable       — Enable/disable watcher
POST   /api/jira/watchers/:id/poll         — Trigger poll now
GET    /api/jira/results                   — List results (paginated, filterable)
POST   /api/jira/results/:id/debug         — Manually trigger debug for result (with optional prompt override)
POST   /api/jira/results/:id/read          — Mark result as read
DELETE /api/jira/results/:id               — Delete result (soft delete)
GET    /api/jira/search                    — Search Jira (for filter builder UI)
GET    /api/jira/ticket/:key               — Get full ticket details
GET    /api/jira/metadata                  — Fetch projects, issue types, priorities, statuses
```

**CLI Commands (src/cli/commands/jira*.ts):**
```
ppm jira config set <project> --url <url> --email <email> --token <token>
ppm jira config show <project>
ppm jira config remove <project>
ppm jira config test <project>
ppm jira watch add <project> <name> --jql <jql> [--mode debug|notify] [--interval 300000]
ppm jira watch list <project>
ppm jira watch enable/disable <project> <watcherId>
ppm jira watch remove <project> <watcherId>
ppm jira watch test <project> <watcherId>
ppm jira watch pull <project> <watcherId>
ppm jira results list <project> [--limit 50]
ppm jira results delete <project> <resultId>
ppm jira track <issue-key>                 — Manually track ticket (insert result, queue debug)
```

**Frontend (src/web/components/jira/):**
- **jira-settings-tab.tsx** — Config form, test button, token input
- **jira-filter-builder.tsx** — JQL builder UI (projects, issue types, priorities, statuses, custom JQL)
- **jira-watcher-list.tsx** — List watchers, enable/disable, edit, delete, poll now, interval controls
- **jira-results-panel.tsx** — Results table (issue key, status, summary, AI summary), unread badge, delete, manual debug button
- **jira-debug-prompt-dialog.tsx** — Modal for prompt override when manually triggering debug
- **jira-ticket-detail.tsx** — Modal with full ticket, AI analysis, debug status
- **jira-store.ts** — Zustand (configs, watchers, results, filters, settings, unread count)

**Key Design Decisions:**
1. **Direct Claude sessions** — Replaced bot_task flow with direct `chatService.sendMessage()` (simpler, faster, no task overhead)
2. **Concurrency queue** — Max 2 concurrent globally, max 1 per project (prevents resource starvation, respects project context)
3. **Manual debug trigger** — Users can override watcher prompt and manually queue debug for any pending result
4. **Unread tracking** — `read_at` column marks when user views result, UI shows unread badge count
5. **Prompt templating** — Support {issue_key}, {summary}, {description}, {status}, {priority} placeholders in watcher templates
6. **Timeout protection** — 10-minute timeout with AbortController graceful cleanup and error capture
7. **WS notifications** — `jira:debug_complete` event streamed to UI for instant toast feedback
8. **Soft deletes** — Results marked deleted=1 (preserve history, don't lose tracking)
