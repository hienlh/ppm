/**
 * What a window shows besides its title — glyph, colour, subtitle, "working" — for both its
 * titlebar and its chip in the status bar's dock, so the two can never disagree.
 *
 * A tab-host window is described by the tab inside it rather than by the kind: a detached
 * terminal is a terminal, a design window is that design. Its title is the tab's live title
 * too, because the one captured in the payload at pop-out time goes stale (a design renamed,
 * a chat that acquired a name).
 */

import type { ElementType } from "react";
import { useShallow } from "zustand/react/shallow";
import { Activity, FolderOpen, Monitor, ScrollText, Settings, Users } from "@/lib/icons";
import { getTabTypeIcon } from "@/lib/tab-type-icons";
import { tabSessionId } from "@/lib/tab-session-id";
import { usePanelStore } from "@/stores/panel-store";
import { useStreamingStore } from "@/stores/streaming-store";
import { NON_PIP_TAB_TYPES, windowPanelId } from "@/stores/panel-utils";
import type { Tab, TabType } from "@/stores/tab-store";
import type { WindowChromeIdentity } from "./window-chrome-contract";
import { windowTitle } from "./window-content-registry";
import type { WindowKind, WindowRuntimeState } from "./window-store-types";

export interface WindowMeta extends WindowChromeIdentity {
  /** The hosted tab's live title, when there is one; the caller falls back to `windowTitle`. */
  title?: string;
  /** What kind of window this is, in words: the dock list's second line. */
  kindLabel: string;
  /** A design: its tile is filled with its own colour rather than tinted. */
  filled: boolean;
}

const tone = (token: string) => `var(--color-${token})`;

/** The colours a design can be given; a design keeps the one its slug hashes to. */
const DESIGN_TONES = ["primary", "accent-2", "success", "warning", "error", "info"].map(tone);

/** A stable colour per design, so one design's chip looks the same in every session. */
export function designTone(slug: string): string {
  let hash = 0;
  for (let i = 0; i < slug.length; i++) hash = (hash * 31 + slug.charCodeAt(i)) | 0;
  return DESIGN_TONES[Math.abs(hash) % DESIGN_TONES.length]!;
}

const KIND_META: Record<Exclude<WindowKind, "tab-host">, { icon: ElementType; tone: string; label: string }> = {
  explorer: { icon: FolderOpen, tone: tone("info"), label: "Explorer" },
  "agent-session": { icon: Users, tone: tone("accent-2"), label: "Agent" },
  "system-monitor": { icon: Activity, tone: tone("warning"), label: "System Monitor" },
  "remote-desktop": { icon: Monitor, tone: tone("info"), label: "Remote Desktop" },
  settings: { icon: Settings, tone: tone("text-3"), label: "Settings" },
  logs: { icon: ScrollText, tone: tone("text-2"), label: "Logs" },
};

const TAB_LABELS: Partial<Record<TabType, string>> = {
  terminal: "Terminal",
  chat: "Chat",
  editor: "Editor",
  design: "Design",
  "git-log": "Git graph",
  "git-diff": "Diff",
  "git-review": "Review changes",
  "session-review": "Session review",
  database: "Database",
  sqlite: "Database",
  "web-preview": "Preview",
  android: "Android",
  extension: "Extension",
  "extension-webview": "Extension",
  assistant: "Assistant",
};

const TAB_TONES: Partial<Record<TabType, string>> = {
  terminal: tone("success"),
  chat: tone("accent-2"),
  assistant: tone("accent-2"),
  "git-log": tone("warning"),
  "git-diff": tone("warning"),
  "git-review": tone("warning"),
};

/** The tab a tab-host window shows: its panel's active tab, else its first. */
function hostedTab(windowId: string): (s: ReturnType<typeof usePanelStore.getState>) => Tab | undefined {
  return (s) => {
    const panel = s.panels[windowPanelId(windowId)];
    if (!panel) return undefined;
    return panel.tabs.find((t) => t.id === panel.activeTabId) ?? panel.tabs[0];
  };
}

/** Pure half of {@link useWindowMeta}: everything but the store reads. */
export function describeWindow(kind: WindowKind, tab: Tab | undefined, busy: boolean): WindowMeta {
  if (kind !== "tab-host") {
    const meta = KIND_META[kind];
    return { icon: meta.icon, tone: meta.tone, kindLabel: meta.label, busy: false, allowPip: true, filled: false };
  }
  if (!tab) return { icon: getTabTypeIcon("editor"), tone: tone("primary"), kindLabel: "Tab", busy: false, allowPip: true, filled: false };
  const isDesign = tab.type === "design";
  const kindLabel = TAB_LABELS[tab.type] ?? "Tab";
  const project = tab.projectId ?? undefined;
  const slug = typeof tab.metadata?.designSlug === "string" ? tab.metadata.designSlug : tab.title;
  return {
    title: tab.title,
    icon: getTabTypeIcon(tab.type),
    tone: isDesign ? designTone(slug) : (TAB_TONES[tab.type] ?? tone("primary")),
    subtitle: project ? `${kindLabel} · ${project}` : kindLabel,
    kindLabel,
    busy,
    allowPip: !NON_PIP_TAB_TYPES.has(tab.type),
    filled: isDesign,
  };
}

/**
 * Each window's searchable words — its live title and its kind — for filtering a list of
 * them in one place instead of row by row.
 */
export function useWindowSearchText(windows: Pick<WindowRuntimeState, "id" | "kind" | "payload">[]): string[] {
  return usePanelStore(useShallow((s) => windows.map((w) => {
    const meta = describeWindow(w.kind, w.kind === "tab-host" ? hostedTab(w.id)(s) : undefined, false);
    return `${meta.title || windowTitle(w.kind, w.payload)} ${meta.kindLabel}`.toLowerCase();
  })));
}

/**
 * Which of `windows` have an AI turn running, for the dock's `+N` button: a busy window
 * folded out of sight must still say so.
 */
export function useBusyWindowIds(windows: Pick<WindowRuntimeState, "id" | "kind">[]): Set<string> {
  const sessionIds = usePanelStore(useShallow((s) =>
    windows.map((w) => (w.kind === "tab-host" ? tabSessionId(hostedTab(w.id)(s)) ?? "" : ""))));
  const running = useStreamingStore(useShallow((s) => sessionIds.map((sid) => (sid ? s.sessions.has(sid) : false))));
  return new Set(windows.filter((_, i) => running[i]).map((w) => w.id));
}

export function useWindowMeta(win: Pick<WindowRuntimeState, "id" | "kind">): WindowMeta {
  const tab = usePanelStore(win.kind === "tab-host" ? hostedTab(win.id) : () => undefined);
  const sessionId = tabSessionId(tab);
  const busy = useStreamingStore((s) => (sessionId ? s.sessions.has(sessionId) : false));
  return describeWindow(win.kind, tab, busy);
}
