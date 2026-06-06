# Proxy Request Logging & Stats

**Date**: 2026-06-02  
**Severity**: High  
**Component**: OAuth Proxy Bridge, SQLite Config  
**Status**: Resolved  
**Commit**: d5029ab

## What Happened

Overnight, runaway Python benchmark scripts from vn-legal-rag drained the 5-hour quota of all 4 Claude accounts via PPM's proxy with ZERO traceability. OAuth proxy requests routed through the SDK bridge had no persistent logging — only ephemeral console output. No way to audit which caller, how many requests, or which accounts were consumed.

## The Brutal Truth

This is infuriating because we had no observability into what broke our quota. A user can accidentally (or maliciously) drain accounts through the proxy and we'd only notice the dead quota. Multi-tenant proxy with no audit trail is irresponsible — shipping without this was a blind spot.

## Technical Details

**Schema**: Migration v28 in `src/services/db.service.ts` creates `proxy_requests` table:
```sql
CREATE TABLE proxy_requests (
  id INTEGER PRIMARY KEY,
  endpoint TEXT NOT NULL,
  model TEXT,
  account_id TEXT,
  account_label TEXT,
  caller_ip TEXT,
  caller_ua TEXT,
  status TEXT NOT NULL, -- 'success'|'error'|'rate_limited'
  duration_ms INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)
```

**Logging coverage** (all 3 proxy paths):
- `proxy.service.ts` intercepts every request in `forward()` / `forwardOpenAi()` / `forwardDirect()` with `performance.now()` timing
- Early-return cases (no account) still logged with status + duration
- Try/catch wraps `insertProxyRequest()` internally — DB write failure never breaks a proxy request

**Retrieval**:
- `GET /proxy/stats` (proxy auth required) returns {lastHour, last24h, total, requestCount}
- `getProxyStats()` service method for programmatic access

**Retention**:
- 30-day cleanup job runs on server startup + daily setInterval
- `cleanupOldProxyRequests(days=30)` removes expired rows

## What We Tried

Initial code review flagged a critical issue: unwrapped `throw` in the logging path could break a previously-working request AND trigger double-insert in the catch block. Fixed by wrapping `insertProxyRequest()` in an internal try/catch so logging failure is safe.

Also applied: cosmetic accuracy update to `CURRENT_SCHEMA_VERSION` (26→28), which was out of sync with actual migration count. Dead constant, zero functional impact, but worth fixing for readability.

## Root Cause Analysis

Multi-tenant proxy with opaque requests is a liability without persistent audit logs. We shipped observability-blind and only noticed the impact after quota exhaustion. The runaway script was the catalyst, but the real failure was: no way to answer "who used what" or "which account did this drain?"

Subagent (docs-manager) claimed `CURRENT_SCHEMA_VERSION` was a "critical bug preventing table creation" — verified FALSE against actual code. Migrations key off `PRAGMA user_version`, not the constant. Lesson: don't trust subagent severity framing without code verification.

## Lessons Learned

1. **Observability is not optional for shared resource proxies.** Log at the service layer (not inside bridge files) — single DRY point covering all code paths.
2. **Logging must be failure-safe.** DB write errors can NEVER break the request being logged. Wrap at the service layer and silently degrade.
3. **Metadata-only logging respects privacy by design.** No message content, no tokens — forensic accountability, not surveillance.
4. **Verify "critical bugs" from subagents.** Dead constants and unused variables aren't bugs. Check the actual code path before trusting severity claims.
5. **Caller IP is advisory, not authoritative.** x-forwarded-for is spoofable without a trusted reverse proxy in front. Use for forensics, not access control.

## Next Steps

1. Monitor proxy stats for anomalies — set up alerts if request count spikes (owner: ops, timeline: this week)
2. Document proxy auth/trust model (owner: tech lead, timeline: pending — currently assumes trusted reverse proxy context)
3. Future: rotate daily stats to cold storage (SQLite → object store) for long-term audit trails (timeline: v0.15)

## Unresolved Questions

- Is the proxy ever fronted by a trusted reverse proxy? If not, caller_ip forensics are unreliable.
- Should proxy stats be exposed to non-admin callers (read-only dashboard)? Currently admin-only.
- Should we alert on quota drain events (e.g., 50+ requests in last 10 min)? Not implemented yet.

---

**Files modified**: src/services/db.service.ts, src/services/proxy.service.ts, src/server/routes/proxy.ts, src/server/index.ts  
**Tests**: 14/14 passing (tests/integration/proxy-requests-table.test.ts)  
**Code review score**: 8/10 (approved)

**Status:** DONE
