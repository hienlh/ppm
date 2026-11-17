/**
 * Opening the Schedules window on whichever presentation the device has: a floating window on a
 * desktop, the `schedules` tab on a phone (`WindowLayer` renders nothing below `md`). There is one
 * list of every schedule, so a second open focuses what is already there.
 *
 * A caller may ask for one schedule to be selected (a task's "Open in Schedules"); the request is
 * held here until the list takes it, because the list may not be mounted yet.
 *
 * A plain function rather than a hook, like `openLogs`: the rail, the drawer, the command palette
 * and a task's page all reach it.
 */
import { isMobileDevice } from "@/hooks/use-is-mobile";
import { useWindowStore } from "@/components/floating-window/window-store";
import { cascadeSpawnRect } from "@/components/floating-window/window-geometry";
import { useTabStore } from "@/stores/tab-store";

export const SCHEDULES_SELECT_EVENT = "ppm:schedules-select";

/** Wide enough for the list and the detail side by side. */
const SCHEDULES_WINDOW_SIZE = { w: 1080, h: 680 } as const;

let pendingSelect: number | null = null;

/** The schedule a list should select when it mounts, if one was asked for; asking clears it. */
export function takeSchedulesSelection(): number | null {
  const id = pendingSelect;
  pendingSelect = null;
  return id;
}

export function openSchedules(opts: { select?: number } = {}): void {
  pendingSelect = opts.select ?? null;
  if (isMobileDevice()) {
    useTabStore.getState().openTab({ type: "schedules", title: "Schedules", projectId: null, closable: true });
  } else {
    const store = useWindowStore.getState();
    const existing = Object.values(store.windows).find((w) => w.kind === "schedules");
    if (existing) store.focus(existing.id);
    else {
      const rect = cascadeSpawnRect(Object.values(store.windows).map((w) => w.rect), store.bounds, SCHEDULES_WINDOW_SIZE);
      store.open("schedules", undefined, rect);
    }
  }
  if (opts.select !== undefined) window.dispatchEvent(new CustomEvent(SCHEDULES_SELECT_EVENT));
}
