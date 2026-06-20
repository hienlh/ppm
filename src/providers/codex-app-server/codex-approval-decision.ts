import type {
  CommandExecutionApprovalDecision,
  FileChangeApprovalDecision,
  ReviewDecision,
} from "./codex-protocol.ts";

/**
 * Server-request methods that carry an approval decision.
 * `item/permissions/requestApproval` is intentionally excluded — its response
 * shape is a granted-permission profile, not a decision; PPM declines it via a
 * JSON-RPC error (see provider.onServerRequest). MVP uses string variants only;
 * object amendments (execpolicy / network) are out of scope.
 */
export type ApprovalMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "execCommandApproval"
  | "applyPatchApproval";

export function isApprovalMethod(method: string): method is ApprovalMethod {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "execCommandApproval" ||
    method === "applyPatchApproval"
  );
}

type Decision =
  | { decision: CommandExecutionApprovalDecision }
  | { decision: FileChangeApprovalDecision }
  | { decision: ReviewDecision };

/**
 * Pure per-method approval decision builder. `approved=true` → accept/approve;
 * `false` → decline/deny; `aborted=true` → cancel (only commandExecution).
 * Legacy methods (execCommandApproval/applyPatchApproval) use ReviewDecision.
 */
export function decisionFor(method: ApprovalMethod, approved: boolean, aborted = false): Decision {
  switch (method) {
    case "item/commandExecution/requestApproval":
      if (aborted) return { decision: "cancel" };
      return { decision: approved ? "accept" : "decline" };
    case "item/fileChange/requestApproval":
      if (aborted) return { decision: "cancel" };
      return { decision: approved ? "accept" : "decline" };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: approved ? "approved" : "denied" };
  }
}
