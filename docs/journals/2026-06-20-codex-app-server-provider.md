# 2026-06-20 — Codex (OpenAI) app-server chat provider

Implemented PPM's 3rd chat provider: Codex over `codex app-server` newline-delimited JSON-RPC (stdio), implementing `AIProvider` directly (mirrors the Claude SDK provider, not the CLI base). Executed from plan `260619-1514-codex-app-server-provider`.

## What shipped
- New module set under `src/providers/codex-app-server/`: provider (live per-session map, multi-turn generator, lifecycle, approvals, history, models), NDJSON JSON-RPC client, hand-authored protocol subset, permission map, event mapper, approval-decision, rollout history parser, model parser, shared redactor.
- Wiring: `registry.ts` bootstrap (registers only when scoped `@openai/codex` resolves) + default config `permission_mode:"bypassPermissions"`; `server/index.ts` `cleanupAll` on shutdown; `ws/chat.ts` connection-timeout error made provider-agnostic; dropped unused `@openai/codex-sdk` devDep; deleted the 86-file generated `codex-appserver-ts/`.
- Tests: 7 unit specs + 1 integration spec (57 pass, 1 gated-live skip, 0 fail).

## Key decisions / gotchas
- **Token streaming is the sole justification for Approach C** — exec/SDK lack it. Verified via the live spike.
- **Approval mode = existing `permissionMode`**, mapped to codex `{sandbox, approvalPolicy}`. Under the default `bypassPermissions` (→ danger-full-access + approvalPolicy `never`) codex emits ZERO approval ServerRequests, so the approval/ask-user-input bridge is protocol-correct but **dormant** in MVP (no UI surfacing without a mode selector).
- **Multi-turn = one persistent generator** draining a per-session event channel; the generator stays alive across turns (yields `done` per turn but does not end), `pushMessage` issues another `turn/start` on the live client. This matches the Claude provider's persistent-generator contract.
- **Decision response shape correction**: the real bindings use `{ decision: "accept" }` with bare-string enums; `item/permissions/requestApproval` returns a granted-profile (not a decision) so it's declined via JSON-RPC error rather than faked.
- **Security (cross-project disclosure)**: `~/.codex/sessions/**` holds every project's transcripts. `listCodexRollouts`, and after code review also `findRolloutByThreadId`/`getRolloutMessages`/resume detection, enforce a FAIL-CLOSED cwd filter (anchored thread-id match + normalized, win32 case-insensitive cwd compare).
- **Env allowlist**: the subprocess never inherits `{...process.env}` — explicit allowlist strips `ANTHROPIC_*`/secrets; codex owns its own `~/.codex/auth.json`.
- **Spawn = scoped `@openai/codex`** via `bun x` (spike-proven), never a PATH `codex` (prank-pkg risk).

## Test execution note
Host Bun segfaults on `bun test`/`tsc`; ran everything via Docker `oven/bun` (`-e PPM_HOME=/tmp/ppmtest -v <repo>:/app`). `tsc --noEmit --ignoreDeprecations 6.0` clean for all changed files (the repo tsconfig's `baseUrl` deprecation otherwise aborts tsc).

## Not done / follow-ups
- **Live mobile + desktop browser verification (P7) not performed** — requires `codex login` + running dev servers + a device. Chat UI / model-selector / `session_migrated` / `approval_request` paths are already provider-agnostic, so no FE changes were needed, but the visual pass is outstanding.
- Mid-session `permissionMode` changes aren't re-applied to an existing live thread (dormant-bridge consequence); model changes already force a fresh connect via the `set_model` abort path.
- Version bump/publish deferred — CHANGELOG entry added under `[Unreleased]`.
