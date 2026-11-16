/**
 * Preview semantics for task tabs, VS Code style: selecting a task in the list shows it in a
 * *preview* tab (italic title) that the next selection replaces; editing the task or double-clicking
 * the row or the tab *keeps* it, after which a selection opens a new preview beside it. One preview
 * task tab per panel. Pure rules, so `panel-store.openTab` stays one hook point and tests need no store.
 */
import type { Tab } from "@/stores/tab-store";

export const TASK_TAB_PREFIX = "task:";

/** One tab per task: `task:<id>` (the URL reads `/project/<p>/task/<id>`). */
export const taskTabId = (taskId: string): string => `${TASK_TAB_PREFIX}${taskId}`;

/** The task a tab shows, if it is a task tab. */
export function taskIdOfTab(tab: Pick<Tab, "type" | "metadata">): string | null {
  if (tab.type !== "task") return null;
  const id = tab.metadata?.taskId;
  return typeof id === "string" && id ? id : null;
}

export const isPreviewTab = (tab: Pick<Tab, "type" | "metadata">): boolean => tab.type === "task" && tab.metadata?.preview === true;

export type TaskTabPlan =
  /** The task is already open somewhere: focus that tab (and keep it, if asked). */
  | { kind: "focus"; panelId: string; tabId: string; keep: boolean }
  /** Swap the panel's preview tab for this task, in the same place. */
  | { kind: "replace"; panelId: string; tabId: string }
  /** Add a new tab to the panel. */
  | { kind: "add"; panelId: string };

export interface PanelTabs {
  id: string;
  tabs: Pick<Tab, "id" | "type" | "metadata">[];
}

/**
 * Where a task tab goes. `panels` lists every panel to look for an open copy (focused one first is
 * not required); `target` is the panel a new or replacing tab lands in; `keep` is true when the open
 * comes from an edit or a double-click rather than a plain selection.
 */
export function planTaskTabOpen(panels: readonly PanelTabs[], target: string, taskId: string, keep: boolean): TaskTabPlan {
  for (const p of panels) {
    const existing = p.tabs.find((t) => taskIdOfTab(t) === taskId);
    if (existing) return { kind: "focus", panelId: p.id, tabId: existing.id, keep: keep && isPreviewTab(existing) };
  }
  const panel = panels.find((p) => p.id === target);
  const preview = keep ? undefined : panel?.tabs.find(isPreviewTab);
  if (preview) return { kind: "replace", panelId: target, tabId: preview.id };
  return { kind: "add", panelId: target };
}

/** The tab list with `oldId` swapped for `next` in the same position. */
export function replaceTabInPlace<T extends { id: string }>(tabs: readonly T[], oldId: string, next: T): T[] {
  const i = tabs.findIndex((t) => t.id === oldId);
  if (i < 0) return [...tabs, next];
  const out = [...tabs];
  out[i] = next;
  return out;
}

/** A tab's metadata once kept: the preview mark is dropped, everything else stays. */
export function keptMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const { preview: _preview, ...rest } = metadata ?? {};
  return rest;
}
