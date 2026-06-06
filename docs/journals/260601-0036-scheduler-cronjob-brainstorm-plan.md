# Scheduler/Cronjob Feature: Brainstorm + Plan Session

**Date**: 2026-06-01 00:36
**Severity**: Medium
**Component**: Scheduler, Cron Integration, Agent Execution
**Status**: Plan validated, ready for implementation

## What Happened

Completed full brainstorm + planning session for recurring job scheduler feature. No code written. Architecture locked. Implementation plan (7 phases, ~47h) drafted and ready for `/ck:cook`.

## Key Architecture Decisions (Locked)

**OS-cron-driven, not in-process**
- ONE OS entry per schedule (launchd / crontab | systemd / schtasks)
- OS fires `ppm schedule run <id>` — self-boots server if down
- Cross-process overlap lock via SQLite, not process-level locks

**Scope reduction: "slash skill" = agent session**
- Only 2 executors needed: agent + shell
- Removes third executor type; simplifies state machine

**Execution pattern mirrors existing chat flow**
- Uses createSession + sendMessage (src/services/chat.service.ts), NOT executeDelegation
- executeDelegation is bot-specific (hardcodes bypassPermissions, bot_tasks coupling)
- Per-schedule permissionMode (default acceptEdits) for cost safety

**OS label prefix**: `sh.ppm` (distinct from autostart's com.hienlh.ppm)
- UI: single global Schedules page (project chosen via form dropdown)
- Telegram notify: keep broadcast() as-is (fires only when no active browser)

**Limits + retention**
- Cron expansion cap: 100 OS entries (reject beyond)
- schedule_runs prune after 30 days
- Shell output: truncated head+tail (32KB+32KB)
- Agent timeout: wall-clock, default 30 min, kill→error

**New dependency**: croner (zero-dep, tz-aware cron parser)

## Critical Codebase Findings

**executeDelegation is NOT reusable for scheduled agent runs**
- Hardcodes permissionMode=bypassPermissions (dangerous for recurring agent jobs)
- Tightly coupled to bot_tasks table
- Must instead use createSession + sendMessage pattern with per-schedule permissionMode

**No existing ensureServerRunning()**
- Implement via /api/health probe + idempotent `ppm start`
- Needed for self-boot on OS cron fire

**autostart-register.ts / autostart-generator.ts pattern**
- Mirror for new SystemCronAdapter (register/unregister OS entries across 3 OSes)
- Key learnings: launchd dict format, schtasks XML, systemd timer files

**notificationService.broadcast() behavior**
- Only fires Telegram when NO active browser client
- Keep as-is for scheduled runs

## Implementation Plan Status

7 phases drafted:
1. Database schema + models (schedule, schedule_run, schedule_trigger)
2. SystemCronAdapter (launchd, systemd, schtasks) + register/unregister
3. Schedule service + execution engine (createSession, sendMessage, overlap lock)
4. CLI commands (schedule create/update/delete/list/run)
5. Backend API endpoints (CRUD, trigger, history)
6. Frontend Schedules page (form, list, run history)
7. Tests + integration

Artifacts saved:
- Brainstorm report: `plans/reports/brainstorm-260601-0036-scheduler-cronjob-feature.md`
- Full plan: `plans/260601-0036-scheduler-cronjob/` (plan.md + phase-01..07)

## Flagged Risks (Mitigated by Design)

| Risk | Mitigation |
|------|-----------|
| Cost runaway: agent runs consuming tokens unbounded | Default permissionMode=acceptEdits (not bypassPermissions); per-run timeout; run history audit |
| 3-OS cron expansion correctness | Build all 3 OS simultaneously; test harnesses for dict gen (launchd) and XML mapping (schtasks) |
| Cross-process overlap (machine catches up, fires multiple times) | SQLite lock with pragma exclusive; per-schedule catch-up flag |
| Catch-up chaos when machine was down | Catch-up check runs only if flag enabled; catches up missed runs, coalesces rapid fire |

## Emotional Reality

This feature is architecturally solid and relatively straightforward compared to git-graph porting pain. The hardest part will be 3-OS parity (launchd dict XML gen, schtasks mapping) and not shipping dangerous cost-runaway agent runs. Scope reduction (slash skill → agent session) made a huge difference — dropped from 3 executors to 2. Design validated via interview; ready to build.

## Next Steps

1. Read full plan at `plans/260601-0036-scheduler-cronjob/plan.md`
2. Delegate `/ck:cook` with plan path
3. Implement phases in order; cross-platform cron adapter most complex (phase 2)
4. After phase 3 (execution engine), run manual tests to verify OS entries fire correctly
5. Full integration test suite in phase 7

**Owner**: Implementation team (delegated)
**Timeline**: ~47h estimate, 1-2 devs
