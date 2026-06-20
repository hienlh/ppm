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

/** Pure map from PPM permissionMode → codex {sandbox, approvalPolicy}. Unknown → bypass. */
export function permissionModeToCodex(mode?: string): CodexPermission {
  return (mode && MAP[mode]) || MAP.bypassPermissions!;
}
