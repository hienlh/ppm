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
 * every way out (web, shell, writes, messages) asks first.
 */
export const ASSISTANT_PERMISSION: CodexPermission = { sandbox: "read-only", approvalPolicy: "untrusted" };

/** Pure map from PPM permissionMode → codex {sandbox, approvalPolicy}. Unknown → bypass. */
export function permissionModeToCodex(mode?: string, opts?: { designSession?: boolean; assistantSession?: boolean }): CodexPermission {
  if (opts?.assistantSession) return ASSISTANT_PERMISSION;
  if (opts?.designSession && mode === "acceptEdits") return DESIGN_ACCEPT_EDITS;
  return (mode && MAP[mode]) || MAP.bypassPermissions!;
}
