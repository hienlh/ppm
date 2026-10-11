/**
 * Wiring for `session-list-store.ts` that the store itself cannot own:
 * resolving a bare project name into the `{name, path}` ref every store
 * action needs, and the two background sync triggers that need no component
 * in scope — going visible while stale, and a `/ws/global` reconnect (see
 * `use-global-events.ts`). The store registers its own hydrator and cache
 * reset (see `session-list-store.ts`), so importing only this module still
 * gets that wiring — every consumer needs `projectRefForName` or
 * `useProjectRef` anyway, which is what keeps it loaded.
 */
import { useMemo } from "react";
import type { ProjectCacheRef } from "@/lib/browser-cache/cache-keys";
import { useProjectStore } from "@/stores/project-store";
import { useSessionListStore, STALE_MS } from "./session-list-store";

/**
 * Resolves a project name (all most call sites have) into the `{name, path}`
 * ref the store keys on. Falls back to the name itself as the path when the
 * project store has not loaded it yet (a brief window at boot) or in a unit
 * test that never registered one — the cache key stays stable either way,
 * it is just less precise than the real path until the project list loads.
 */
export function projectRefForName(name: string): ProjectCacheRef {
  const found = useProjectStore.getState().projects.find((p) => p.name === name);
  return { name, path: found?.path ?? name };
}

/**
 * Reactive counterpart of `projectRefForName`, for a component that renders
 * before the project list has loaded (a cold boot straight into a project
 * tab). The path resolves — and the ref identity changes — once
 * `useProjectStore`'s list arrives, so an effect keyed on this recomputes
 * against the real cache id instead of sticking with the name-as-path
 * fallback for the component's whole lifetime.
 */
export function useProjectRef(name: string | undefined): ProjectCacheRef | null {
  const path = useProjectStore((s) => (name ? s.projects.find((p) => p.name === name)?.path : undefined));
  return useMemo(() => (name ? { name, path: path ?? name } : null), [name, path]);
}

/** A `/ws/global` reconnect may have missed updates while the socket was
 * down, so every project this browser already knows about is re-synced —
 * not just the currently active one, since a background tab's tab-bar tags
 * still read the store too. */
export function syncAllKnownProjects(): void {
  const state = useSessionListStore.getState();
  for (const entry of Object.values(state.byProject)) {
    if (entry.project) void state.sync(entry.project);
  }
}

/**
 * The server says a project's session list changed without a browser asking — a session the
 * Assistant started, or one a Telegram `/new` made. Only a project this browser already holds
 * a list for is re-synced: one nobody has read is fetched when something first shows it, so
 * syncing it here would only spend a request on a list no screen is waiting for.
 */
export function syncKnownProject(name: string): void {
  const state = useSessionListStore.getState();
  for (const entry of Object.values(state.byProject)) {
    if (entry.project?.name === name) void state.sync(entry.project);
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    const state = useSessionListStore.getState();
    const now = Date.now();
    for (const entry of Object.values(state.byProject)) {
      if (!entry.project) continue;
      const stale = entry.lastSyncedAt === null || now - entry.lastSyncedAt > STALE_MS;
      if (stale) void state.sync(entry.project);
    }
  });
}
