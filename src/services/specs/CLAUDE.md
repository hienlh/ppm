# `src/services/specs/`

## Map

Spec mode: a chat writes `requirements.md` (or `bugfix.md`) → `design.md` → `tasks.md` under `<project>/specs/<slug>/`, the user approves each in PPM, then the tasks run one at a time or wave by wave (Run all). Formats are Kiro's; the parser is `src/shared/spec-format.ts`, the waves `src/shared/spec-waves.ts`, the shapes `spec-types.ts` / `spec-view.ts` / `spec-tools.ts` beside them.

- `spec-store.ts` — paths and the state sidecar `<ppm dir>/specs/<project key>/<slug>.json`, plus `sessions.json` (which chat is bound to which spec, and for a task chat which task).
- `spec-gates.ts` — every "may this happen now", one pure function of the documents and the state. Routes, tools, scheduler and the browser's buttons all ask it.
- `spec.service.ts` — the one door for every change, one lock per spec. Emits `spec:changed` (`spec-events.ts`, relayed by `ws/global.ts` with the project name).
- `spec-mcp-endpoint.ts` + `spec-mcp-tools.ts` + `spec-mcp-tokens.ts` — the `ppm-specs` tools on `/api/specs-mcp`, mounted before auth like `/api/tab-tools-mcp`. Cursor has no MCP here: it gets `PPM_SPEC_URL` / `PPM_SPEC_TOKEN` and calls `ppm spec call <tool>`.
- `spec-context.ts` — the `<ppm_spec_state>` block `chatService.prepareSendOptions` appends to the shared context of a bound chat (rules, where the spec stands, the next step).
- `spec-scheduler.ts` — Run all; its server hooks (create a task chat, deliver a message, turn state) are set in `src/server/ws/spec-run-env.ts`.
- `test-runner.ts` + `test-judge.ts` — Thorough's red/green: run design.md's approved `ppm-test` command, decide fail vs broken vs pass.
- `spec-design-link.ts` — `UI: yes` specs get a PPM Design; its file hash is approved like a document.
- Routes `src/server/routes/specs.ts` (`/api/project/:name/specs`), `POST /chat/sessions` takes `spec` to start a chat in Spec mode. CLI `src/cli/commands/spec-cmd.ts`. UI `src/web/components/spec/`, `src/web/hooks/use-spec.ts`, `src/web/lib/api-specs.ts`.
- Tests `tests/unit/specs/` (the service test runs a real `bun test` red → green).

## Gotchas

- **Approvals live in the PPM dir, never in the project**: anything in `specs/<slug>/` is writable by the AI's file tools, so a flag there could approve a phase or turn Thorough into Standard. The state file holds a hash per approved document; editing the document makes it `stale`, and a stale phase blocks every phase after it.
- **tasks.md is hashed with its boxes cleared**: PPM ticks a box when a task finishes, which must not reopen the approved plan. In Thorough a box the AI ticked itself counts only if it was ticked when the plan was approved (`preDone`); only `task_green` finishes a task.
- **A token names a session, not a spec**: the binding is looked up at every call, through the session's aliases, because a Codex session id migrates on its first turn and a chat can enter Spec mode after its CLI started. For the same reason the tools are attached to every non-design chat while they are switched on: a CLI keeps the MCP servers it started with, so attaching them only to bound chats would leave a chat that enters Spec mode mid-way without them.
- **The spec block must be stripped before `rememberSharedContext` hashes the shared context**: it changes with every step, and the shared context is sent again whenever its hash moves. `splitSpecContext` removes it first.
- **A task chat is held to its task**: the endpoint refuses another task id, `spec_submit` and `spec_open_design` from a chat bound with a `taskId`. The approvals and the check level have no tool at all; `ppm spec approve` / `ppm spec checks` refuse under `PPM_AI_CHAT`. That is a guard, not a boundary: an AI with a shell can still read the auth token and call the REST route.
- **Red has to be a run that fails on an assertion**: a missing module, a syntax error or a file that never loaded is `broken` and does not count. The test files must have changed since `task_start`, and they are locked once red is recorded: green is refused while any of them differs from what failed, so the code is made to pass the tests and not the other way round.
- **The whole-suite check is against a baseline taken when Thorough execution starts**: only failures not in the baseline block. It runs after a lone task's green, or once per finished wave under Run all (a green while siblings still run defers it). New failures stop every later task until `suite_check` passes.
- **Runs live in the server process**: a restart leaves the spec's run marked active with no controller, which the view reports as interrupted (`runLive: false`); the user starts it again. A child chat that goes idle for 20 s without finishing its task marks the task failed; the rest of its wave finishes and later waves wait.
- **The drawing hash skips `design.json`**: the manifest changes on a rename or PPM's own bookkeeping. Everything else in `designs/<slug>/` counts, so any edit to the drawing reopens Design.
