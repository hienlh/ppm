import type { SandboxMode, AskForApproval } from "./codex-protocol.ts";

/**
 * Codex thread/start permission knobs derived from PPM's existing permissionMode.
 * Codex's "approval mode" preset (Ask / Approve-for-me / Full access) is the same
 * mental model as Claude Code permission modes, so we reuse permissionMode rather
 * than introducing a separate sandbox axis.
 */
export interface CodexPermission {
  sandbox: SandboxMode;
  approvalPolicy: AskForApproval;
}

const MAP: Record<string, CodexPermission> = {
  // Full access — no prompts. Parity with Claude/cursor default.
  bypassPermissions: { sandbox: "danger-full-access", approvalPolicy: "never" },
  // Approve-for-me — workspace writes allowed, escalations prompt.
  acceptEdits: { sandbox: "workspace-write", approvalPolicy: "on-request" },
  // Ask-for-approval — read-only sandbox, prompt to escalate.
  default: { sandbox: "read-only", approvalPolicy: "on-request" },
  // Plan — read-only, never act.
  plan: { sandbox: "read-only", approvalPolicy: "never" },
};

/**
 * A design session's acceptEdits: file edits stay inside the workspace, and any command
 * outside codex's trusted read-only set asks first. `on-request` would let the model run
 * arbitrary commands in the sandbox unasked, which is the opposite of the design default
 * ("edits yes, shell asks"). Residual, and accepted: codex still auto-runs its trusted
 * read-only commands (`cat`, `ls`, …) and its sandbox can read outside the workspace.
 */
const DESIGN_ACCEPT_EDITS: CodexPermission = { sandbox: "workspace-write", approvalPolicy: "untrusted" };

/**
 * A PPM Assistant session, whatever mode was asked for: nothing may be written, and any
 * command outside codex's trusted read-only set comes to the user as an approval card. The
 * read-only sandbox also has no network, so an approved-looking command cannot reach out on
 * its own. Residual, and accepted: codex still runs its trusted read-only commands (`cat`,
 * `ls`, …) unasked and can read outside the registered projects with them — there is no
 * per-path rule to give it — so with codex the guard against leaking what it reads is that
 * every way out (web, shell, writes, messages) asks first. A command approval the read-only
 * check (`assistant-shell-decision.ts`) shows only reads is accepted without a card, and a file
 * change is declined without one unless the user lets the Assistant act on its own.
 */
export const ASSISTANT_PERMISSION: CodexPermission = { sandbox: "read-only", approvalPolicy: "untrusted" };

/**
 * `TurnStartParams.sandboxPolicy`, in the shape codex-cli 0.163's app-server schema gives it
 * (`codex app-server generate-json-schema`): `readOnly`, or `workspaceWrite` with absolute
 * `writableRoots` and `networkAccess` (both optional there, both always sent here).
 */
export type CodexTurnSandboxPolicy =
  | { type: "readOnly" }
  | { type: "workspaceWrite"; writableRoots: string[]; networkAccess: false };

/**
 * The approval and sandbox policy an Assistant session sends with every `turn/start`. A turn's
 * override persists into later turns, so each turn names its own. `writableRoots` is non-null
 * only for "act on its own" (a turn the user started, with the switch on): the turn may then
 * write in those folders — the registered projects that hold nothing private — and asks only to
 * escalate. Every other turn, and one with no such project, is back on the profile above.
 * Neither has network access. Codex also keeps the session's own working folder (the
 * Assistant's empty scratch folder) and the temp folder writable under `workspaceWrite`.
 */
export function assistantTurnPolicy(writableRoots: readonly string[] | null): { approvalPolicy: AskForApproval; sandboxPolicy: CodexTurnSandboxPolicy } {
  return writableRoots && writableRoots.length > 0
    ? { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", writableRoots: [...writableRoots], networkAccess: false } }
    : { approvalPolicy: ASSISTANT_PERMISSION.approvalPolicy, sandboxPolicy: { type: "readOnly" } };
}

/** Pure map from PPM permissionMode → codex {sandbox, approvalPolicy}. Unknown → bypass. */
export function permissionModeToCodex(mode?: string, opts?: { designSession?: boolean; assistantSession?: boolean }): CodexPermission {
  if (opts?.assistantSession) return ASSISTANT_PERMISSION;
  if (opts?.designSession && mode === "acceptEdits") return DESIGN_ACCEPT_EDITS;
  return (mode && MAP[mode]) || MAP.bypassPermissions!;
}
