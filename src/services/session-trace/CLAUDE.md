# `src/services/session-trace/`

## Map

- `src/services/session-trace/` — the session trace ("every run is traceable"): its own `session-trace.db` (outside `db-backup` — a log, not state), one trace per run keyed by the PPM session id with `trace_aliases` for ids a provider migrated to. `ChatService` records every input it handles (`user_message`, `context_added`, `approval_resolved`, `turn_aborted`) and every provider event, text/thinking deltas coalesced per block (`trace-coalescer.ts`), through a batching writer that never throws into a chat (`trace-writer.ts`). Browser half: `src/web/lib/trace-client.ts` (every console level; errors carry the 50 lines before them) posting to `POST /api/trace` keyed by device id, plus the inline watchdog beacon in `index.html`. Read a session with `GET /api/trace/sessions/:id`; retention in `session-trace-cleanup.ts`. Design and as-built notes: `docs/architecture/plugins-and-tracing.md`

## Gotchas

- **The Claude SDK interleaves a data-less `system/thinking_tokens` between every two thinking deltas**, so anything folding *consecutive* deltas folds nothing: the trace's coalescer turned one real turn into 92 rows, 84 of them single deltas and ticks. The provider forwards every SDK system message it does not special-case as a bare `{type, subtype}` (`claude-agent-sdk.ts`), and that shape is how to recognise a signal — `trace-coalescer.ts` counts one arriving inside a block on the block (`signals`) instead of closing it. A mock or scripted provider that never sends these hides the bug entirely, which is why the replay test's script now does.
