/** Pure viewport-routing decision for the System Monitor open-hook — split out from
 *  `use-open-system-monitor.ts` so it has zero runtime imports (only a type-only one,
 *  fully erased) and is unit-testable without mounting zustand stores. */
import type { Tab } from "@/stores/tab-store";

export type OpenSystemMonitorAction =
  | { kind: "tab"; tab: Omit<Tab, "id"> }
  | { kind: "window" }
  | { kind: "focus"; id: string };

/**
 * There is exactly one machine, so unlike `"explorer"`/`"team-member"` (legitimately
 * multi-instance — different payload, different folder/teammate), a second
 * `"system-monitor"` window is never a distinct instance, only a duplicate. When one
 * is already open, focus it instead of spawning another.
 */
export function resolveOpenSystemMonitorAction(
  isMobile: boolean,
  existingWindowId: string | null,
): OpenSystemMonitorAction {
  if (isMobile) {
    return {
      kind: "tab",
      tab: { type: "system-monitor", title: "System Monitor", projectId: null, closable: true },
    };
  }
  if (existingWindowId) return { kind: "focus", id: existingWindowId };
  return { kind: "window" };
}
