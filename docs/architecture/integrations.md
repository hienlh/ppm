# Integrations (PPMBot, Jira)

> Part of the [PPM system architecture](../system-architecture.md).

## PPMBot Coordinator Service Layer (Telegram-based Team Leader)
**Component:** PPMBot coordinator orchestrator + delegation executor

**Responsibilities:**
- Manage single persistent coordinator session per Telegram chat in `~/.ppm/bot/` workspace
- Route incoming Telegram messages to coordinator (ask/answer) or delegation tracking
- Decide when to answer directly vs. delegate to subagents (based on project context)
- Execute delegated tasks in isolated project sessions
- Track task status and report results back to Telegram
- Format responses as Telegram HTML with progressive message editing

**Architecture:**
```
Telegram → PPMBotTelegramService (polling) → PPMBotService (orchestrator)
                                                 ↓
                            PPMBotSessionManager (coordinator session per chat)
                            coordinatorSession.id → chatService.sendMessage()
                            Task Poller (5s interval)
                            ↓
                    executeDelegation(taskId, telegram, providerId)
                    ├─ getBotTask(taskId) → prompt
                    ├─ chatService.createSession(providerId, projectPath)
                    ├─ run async generator (abort, 900s timeout)
                    └─ updateBotTaskStatus(taskId, "completed", {result})
                    ↓
                    telegram.sendMessage(chatId, result summary)
```

**Services (src/services/ppmbot/):**
- **PPMBotService** — Lifecycle (start/stop), message queue, Telegram polling loop, task poller loop
- **PPMBotSessionManager** — Coordinator session cache per chatID, project resolver (case-insensitive, prefix match)
- **PPMBotTelegramService** — Telegram Bot API (getUpdates polling, sendMessage, editMessage, setTyping)
- **PPMBotMemoryService** — SQLite project memories, contextual recall
- **executeDelegation()** — Task execution in isolated session, result capture, timeout/abort handling
- **PPMBotFormatterService** — Markdown → Telegram HTML, 4096-char chunking
- **PPMBotStreamerService** — ChatEvent → progressive Telegram message edits (1s throttle)

**Coordinator Identity (Persistent Cross-Provider):**
- Location: `~/.ppm/bot/coordinator.md` (loaded on startup, cached in `coordinatorIdentity`)
- Role definition: Team leader, project coordinator, decision-maker
- Decision framework: Answer directly (no project context) vs. Delegate (file access needed)
- Coordination tools: Bash-safe CLI commands (`ppm bot delegate`, `ppm bot task-status`, etc.)
- Cross-provider: Identity text injected as XML context block, works with Claude SDK + CLI providers

**Delegation Flow:**
1. User asks task in Telegram
2. Coordinator decides: delegate? → yes
3. Coordinator calls bash: `ppm bot delegate --chat <chatId> --project <name> --prompt "<enriched>"`
4. CLI creates `bot_tasks` row, returns taskId
5. Service tells user: "Working on it, I'll notify you when done"
6. Background poller (5s) detects pending task
7. Executes: `chatService.createSession()` in target project
8. Streams response, captures summary + full output
9. Updates task status → "completed"
10. Sends Telegram notification with result

**Task Execution (Isolation & Safety):**
- Each task = fresh isolated session (no shared context)
- Timeout: 900s default (configurable per task)
- Abort: AbortController on timeout, can be canceled mid-execution
- Result capture: Both summary (for notification) and full text (for detailed review)
- Error handling: Task status → "failed", error message stored, user notified

**Database Schema (v14):**
- `bot_tasks` — id (UUID), chatId, projectName, projectPath, prompt, status, resultSummary, resultFull, sessionId, error, reported, timeoutMs, createdAt, startedAt, completedAt
- Indexes: `idx_bot_tasks_status` (fast poller lookup), `idx_bot_tasks_chat` (history queries)

**Key Design Decisions:**
1. **Single coordinator session** — Per chat, persistent, one identity (vs. per-task sessions in ClawBot)
2. **Delegation via CLI** — Coordinator calls bash commands (safer than direct DB writes, auditable)
3. **Isolated task execution** — Each delegated task spawns fresh session (no context bleed)
4. **Background polling** — Task execution decoupled from message handler (non-blocking)
5. **Result summary + full** — Notification shows short summary; user can fetch full output via CLI
6. **Cross-provider identity** — Single `coordinator.md` works with any AI provider
7. **Bash-safe tools only** — Coordinator restricted to Bash, Read, Write, Edit, Glob, Grep (safe delegation)

**CLI Expansion (ppm bot commands):**
```
ppm bot delegate --chat <id> --project <name> --prompt "<text>"  # Create task
ppm bot task-status <id>                                          # Check status
ppm bot task-result <id>                                          # Get full output
ppm bot tasks [--chat <id>]                                       # List recent
ppm bot project list                                              # Available projects
ppm bot project current                                           # Active project
ppm bot project switch <name>                                     # Switch project
ppm bot session new <title>                                       # Create session
ppm bot session list                                              # List sessions
ppm bot session resume <id>                                       # Resume session
ppm bot session stop <id>                                         # Stop session
ppm bot status                                                    # Bot health
ppm bot version                                                   # PPM version
ppm bot restart                                                   # Restart service
ppm bot help                                                      # Help
```

**Settings UI (ppmbot-settings-section.tsx):**
- Enable/disable PPMBot
- Paired Telegram chats (approval management)
- Default project selection
- System prompt customization
- Task auto-refresh (poll interval, max history)
- Delegated tasks panel (status, result preview, delete)

**Legacy `clawbot` naming:** PPMBot replaced an earlier bot called ClawBot, but the config key and
its REST surface were never renamed. `config.clawbot` (typed `PPMBotConfig`) and
`GET|PUT /api/settings/clawbot` configure **PPMBot** — toggling `enabled` there starts or stops
`ppmbotService`. The old `ClawBotService` / `ClawBotSessionService` / `ClawBotMemoryService` /
`ClawBotStreamerService` no longer exist; the implementation is `src/services/ppmbot/*`. Treat
`clawbot` purely as a backward-compatible key name, not as a separate subsystem.

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
