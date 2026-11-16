/**
 * Where a new task window opens, and remembering where the user last put one.
 *
 * Every open window keeps its own rect across a reload (`window-persistence.ts`). This adds the
 * part a window that is gone cannot give: the next task window opens where the last one was
 * moved or resized to, once it has been closed. A second task window beside an open one steps
 * down and right from it, the way the layer cascades every window. Stored per device
 * (localStorage), like the windows themselves.
 */
import { usePanelStore } from "@/stores/panel-store";
import { windowPanelId } from "@/stores/panel-utils";
import { useWindowStore } from "@/components/floating-window/window-store";
import type { Rect } from "@/components/floating-window/window-geometry";
export { taskWindowSpawnRect } from "./task-open-plan";

const STORAGE_KEY = "ppm-task-window-rect";

function isRect(v: unknown): v is Rect {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (["x", "y", "w", "h"] as const).every((k) => typeof r[k] === "number" && Number.isFinite(r[k]));
}

export function loadTaskWindowRect(): Rect | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return isRect(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveTaskWindowRect(rect: Rect): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rect));
  } catch {
    /* storage off or full: the next window opens at the default place */
  }
}

/** Whether a window is a tab-host showing a task. */
export function isTaskWindow(windowId: string): boolean {
  const panel = usePanelStore.getState().panels[windowPanelId(windowId)];
  const active = panel?.tabs.find((t) => t.id === panel.activeTabId) ?? panel?.tabs[0];
  return active?.type === "task";
}

/** The rects of the task windows on screen, back to front. */
export function openTaskWindowRects(): Rect[] {
  return Object.values(useWindowStore.getState().windows)
    .filter((w) => w.kind === "tab-host" && w.state !== "minimized" && isTaskWindow(w.id))
    .sort((a, b) => a.rank - b.rank)
    .map((w) => w.rect);
}

let watching = false;

/**
 * Remembers each task window's rect when the user moves or resizes it. Started by the first task
 * opened and by every task page that mounts (a window restored by a reload); a no-op after that.
 * Only a window shown normally counts: a maximized or snapped one is not a size to come back to.
 */
export function watchTaskWindowRects(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  useWindowStore.subscribe((s, prev) => {
    for (const w of Object.values(s.windows)) {
      if (w.kind !== "tab-host" || w.state !== "normal") continue;
      const before = prev.windows[w.id];
      if (!before || before.rect === w.rect) continue;
      if (isTaskWindow(w.id)) saveTaskWindowRect(w.rect);
    }
  });
}
