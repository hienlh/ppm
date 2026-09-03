/**
 * Badge vocabulary for agent-team messages.
 *
 * The team activity panel, the activity popover and the SendMessage tool card all
 * label the same message kinds, so the map lives here instead of being copied per
 * surface. Keys match `TeamMessageItem.parsedType` (see `src/types/team.ts`) and the
 * protocol `type` a SendMessage payload can carry.
 */
export const TYPE_BADGES: Record<string, { label: string; className: string }> = {
  task_assignment: { label: "task", className: "bg-primary/20 text-primary" },
  idle_notification: { label: "idle", className: "bg-warning/20 text-warning" },
  completion: { label: "done", className: "bg-success/20 text-success" },
  shutdown_request: { label: "shutdown", className: "bg-error/20 text-error" },
  shutdown_approved: { label: "shutdown ✓", className: "bg-text-3/20 text-text-3" },
  shutdown_response: { label: "shutdown reply", className: "bg-text-3/20 text-text-3" },
  plan_approval_request: { label: "plan review", className: "bg-primary/20 text-primary" },
  plan_approval_response: { label: "plan reply", className: "bg-primary/20 text-primary" },
};
