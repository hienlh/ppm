import { create } from "zustand";
import { api } from "@/lib/api-client";

interface NotificationEntry {
  count: number;
  /** Last notification type: done, approval_request, question */
  type: string;
  projectName: string;
  sessionTitle: string | null;
}

/** Badge color per notification type (Tailwind bg class) */
const TYPE_COLORS: Record<string, string> = {
  approval_request: "bg-red-500",
  question: "bg-amber-500",
  done: "bg-blue-500",
};

/** Priority: higher = more urgent (used to pick "worst" badge color) */
const TYPE_PRIORITY: Record<string, number> = {
  done: 0,
  question: 1,
  approval_request: 2,
};

/** Get badge color class for a notification type */
export function notificationColor(type: string | null | undefined): string {
  return (type && TYPE_COLORS[type]) || "bg-red-500";
}

/** Subtle bg tint per notification type (for unread row highlights) */
const TYPE_TINTS: Record<string, string> = {
  approval_request: "bg-red-500/10",
  question: "bg-amber-500/10",
  done: "bg-blue-500/10",
};

/** Get subtle background tint class for a notification type */
export function notificationTint(type: string | null | undefined): string {
  return (type && TYPE_TINTS[type]) || "bg-red-500/10";
}

interface NotificationStore {
  notifications: Map<string, NotificationEntry>;
  addNotification: (sessionId: string, type: string, projectName: string, sessionTitle?: string | null) => void;
  clearForSession: (sessionId: string) => void;
  clearAll: () => void;
  /** Hydrate from backend on app load */
  loadFromServer: (projectName: string) => Promise<void>;
  /** Handle WS broadcast for cross-tab/device sync */
  handleUnreadChanged: (sessionId: string, unreadCount: number, unreadType: string | null, projectName: string, sessionTitle?: string | null) => void;
}

export const useNotificationStore = create<NotificationStore>()((set) => ({
  notifications: new Map(),

  addNotification: (sessionId, type, projectName, sessionTitle) => {
    set((state) => {
      const next = new Map(state.notifications);
      const existing = next.get(sessionId);
      next.set(sessionId, {
        count: (existing?.count ?? 0) + 1,
        type,
        projectName,
        sessionTitle: sessionTitle ?? existing?.sessionTitle ?? null,
      });
      return { notifications: next };
    });
  },

  clearForSession: (sessionId) => {
    // Grab projectName before deleting the entry
    const entry = useNotificationStore.getState().notifications.get(sessionId);
    const projectName = entry?.projectName;
    set((state) => {
      if (!state.notifications.has(sessionId)) return state;
      const next = new Map(state.notifications);
      next.delete(sessionId);
      return { notifications: next };
    });
    // Fire-and-forget: persist to server so other tabs/devices sync
    if (projectName) {
      api.post(`/api/project/${encodeURIComponent(projectName)}/chat/sessions/${encodeURIComponent(sessionId)}/read`).catch(() => {});
    }
  },

  clearAll: () => set({ notifications: new Map() }),

  loadFromServer: async (projectName: string) => {
    try {
      const entries = await api.get<Array<{ sessionId: string; unreadCount: number; unreadType: string | null; projectName: string | null; sessionTitle: string | null }>>(
        `/api/project/${encodeURIComponent(projectName)}/chat/sessions/unread`,
      );
      set(() => {
        const next = new Map<string, NotificationEntry>();
        for (const e of entries) {
          if (e.unreadCount > 0) {
            next.set(e.sessionId, { count: e.unreadCount, type: e.unreadType || "done", projectName: e.projectName || "", sessionTitle: e.sessionTitle ?? null });
          }
        }
        return { notifications: next };
      });
    } catch { /* server may not support yet — keep empty */ }
  },

  handleUnreadChanged: (sessionId, unreadCount, unreadType, projectName, sessionTitle) => {
    set((state) => {
      const next = new Map(state.notifications);
      if (unreadCount === 0) {
        next.delete(sessionId);
      } else {
        // unreadCount === -1 means "incremented, re-fetch actual count not available" — just +1 locally
        const existing = next.get(sessionId);
        next.set(sessionId, {
          count: unreadCount > 0 ? unreadCount : (existing?.count ?? 0) + 1,
          type: unreadType || "done",
          projectName: projectName || existing?.projectName || "",
          sessionTitle: sessionTitle ?? existing?.sessionTitle ?? null,
        });
      }
      return { notifications: next };
    });
  },
}));

/** Derived: number of sessions with unread notifications */
export function selectTotalUnread(state: { notifications: Map<string, NotificationEntry> }): number {
  return state.notifications.size;
}

/** Derived: most urgent notification type for a project (null = no unread) */
export function selectProjectUrgentType(projectName: string) {
  return (state: { notifications: Map<string, NotificationEntry> }): string | null => {
    let best: string | null = null;
    let bestPri = -1;
    for (const [, entry] of state.notifications) {
      if (entry.projectName !== projectName) continue;
      const pri = TYPE_PRIORITY[entry.type] ?? 0;
      if (pri > bestPri) { bestPri = pri; best = entry.type; }
    }
    return best;
  };
}
