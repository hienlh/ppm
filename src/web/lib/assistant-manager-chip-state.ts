/**
 * The dot on a manager chip and in the filter list: green while the manager chat is working, red
 * while something of that project waits on the user, grey otherwise. Working wins, because a
 * chat that is running is the thing most likely to change what waits.
 */
export type ManagerDotState = "running" | "needs" | "idle";

export function managerDotState(manager: { phase: string; waiting: number }, liveWaiting?: number): ManagerDotState {
  if (manager.phase && manager.phase !== "idle") return "running";
  return (liveWaiting ?? manager.waiting) > 0 ? "needs" : "idle";
}

/** The dot's classes, shared by the chip and the filter rows. */
export const MANAGER_DOT_CLASS: Record<ManagerDotState, string> = {
  running: "bg-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-success)_18%,transparent)]",
  needs: "bg-error",
  idle: "bg-text-subtle",
};

export const MANAGER_DOT_LABEL: Record<ManagerDotState, string> = {
  running: "working",
  needs: "waiting on you",
  idle: "idle",
};
