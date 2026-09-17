# v0.20.3: Preserve Codex session identity when history is missing

Date: 2026-09-15

## What happened

An existing Codex session could fall through to `thread/start` when its rollout transcript was unavailable. PPM then migrated the original session ID to a fresh thread, making an older conversation open with only its continuation. Account rotation had the same fallback.

## Change

- Track explicitly created, unstarted sessions. Only these may start a thread without history; consume eligibility after a successful start.
- Reject resume when no transcript attributable to the project is available. Tell the user to restore history or explicitly open a new chat.
- Check history before replacing the client or account binding during rotation. Resume the outgoing account's transcript on the selected account.
- Clean up failed connections while preserving retry eligibility for a session whose first start failed.

The earlier local data repair restored an affected session's saved linkage separately. This release ships generic prevention code; it does not automatically repair historical database redirects.

## Verification

Regression coverage exercises missing-history resume, consumed session IDs and aliases, failed-start retry, account rotation, and cross-account history recovery. Release review passed 84 targeted tests across eight files and TypeScript checking.

## Separate follow-up

Review reproduced a pre-existing stale-copy case in `localizeRollout`: after A-to-B transfer and new messages on B, transferring back to A keeps A's existing older file. This release addresses missing rollouts; choosing between existing copies needs separate repair and regression coverage.
