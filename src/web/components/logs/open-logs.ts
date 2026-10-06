/**
 * Opening Logs on whichever presentation the device has: a floating window on a desktop, the
 * `logs` tab on a phone (`WindowLayer` renders nothing below `md`). There is one set of logs,
 * so a second open focuses what is already there.
 *
 * A caller may say where to land — a sub-tab, one chat's lines, one source. That request is
 * held here until a Logs view takes it, because the view it is meant for may not be mounted
 * yet (a window opened by this very call), and an already-mounted one hears it as
 * `LOGS_NAVIGATE_EVENT`. Either way it is taken once, so a later plain open starts clean.
 *
 * A plain function rather than a hook, like `openSettings`: the command palette's actions and
 * a chat's menu both reach it, and the viewport is read when the person acts.
 */
import { isMobileDevice } from "@/hooks/use-is-mobile";
import { useWindowStore } from "@/components/floating-window/window-store";
import { cascadeSpawnRect } from "@/components/floating-window/window-geometry";
import { useTabStore } from "@/stores/tab-store";
import type { LogSourceId } from "../../../shared/logs-model";

export const LOGS_VIEWS = ["logs", "issues", "report"] as const;
export type LogsView = (typeof LOGS_VIEWS)[number];

export function parseLogsView(value: unknown): LogsView {
  return LOGS_VIEWS.includes(value as LogsView) ? (value as LogsView) : "logs";
}

export interface LogsNavigation {
  view?: LogsView;
  /** Show only this chat's lines. */
  chat?: string;
  src?: LogSourceId;
}

export const LOGS_NAVIGATE_EVENT = "ppm:logs-navigate";

/** The design's window: wide enough for the sources, the tag column and a log line side by side. */
const LOGS_WINDOW_SIZE = { w: 1180, h: 720 } as const;

let pending: LogsNavigation | null = null;

/** The request a Logs view should apply, if any; asking clears it. */
export function takeLogsNavigation(): LogsNavigation | null {
  const nav = pending;
  pending = null;
  return nav;
}

export function openLogs(nav?: LogsNavigation): void {
  pending = nav ?? null;
  if (isMobileDevice()) {
    useTabStore.getState().openTab({ type: "logs", title: "Logs", projectId: null, closable: true });
  } else {
    const store = useWindowStore.getState();
    const existing = Object.values(store.windows).find((w) => w.kind === "logs");
    if (existing) {
      if (nav?.view) store.setPayload(existing.id, { view: nav.view });
      if (existing.state === "minimized") store.setState(existing.id, "normal");
      store.focus(existing.id);
    } else {
      const rect = cascadeSpawnRect(Object.values(store.windows).map((w) => w.rect), store.bounds, LOGS_WINDOW_SIZE);
      store.open("logs", nav?.view ? { view: nav.view } : undefined, rect);
    }
  }
  if (nav) window.dispatchEvent(new CustomEvent(LOGS_NAVIGATE_EVENT));
}
