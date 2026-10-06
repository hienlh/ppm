/**
 * `GET /git/changes` for the project's current repository, kept current.
 *
 * Read again 300 ms after PPM writes to the repository (`git:changed`) or a
 * file of the project changes (`file:changed`), and every 5 s while the page is
 * visible for what neither reports — a `git add` typed in a terminal.
 *
 * Every answer also goes to `git-status-store`, so the sidebar badge, the
 * explorer's decorations and the status bar move with this panel:
 * `useGitChangesPoller` stands down while Source Control is open, and the
 * decorations used to freeze for exactly as long as it was.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { useGitRepo } from "@/hooks/use-git-repo";
import { changesToStatus } from "@/lib/git-changes-view";
import { useGitStatusStore } from "@/stores/git-status-store";
import type { GitChanges } from "../../shared/git-changes";

const EVENT_DELAY_MS = 300;
const POLL_MS = 5000;

export interface UseGitChanges {
  /** Null until the current repository has answered once. */
  changes: GitChanges | null;
  error: string | null;
  loading: boolean;
  /**
   * Read again now; resolves with the answer — the newer read's, when one overtook it —
   * or null when it failed or the repository changed under it.
   */
  refresh: () => Promise<GitChanges | null>;
}

export function useGitChanges(projectName: string | undefined): UseGitChanges {
  const gitRepo = useGitRepo(projectName);
  const url = projectName && gitRepo.repo ? gitRepo.gitUrl("/changes") : null;
  const { rebaseStatus } = gitRepo;
  const [loaded, setLoaded] = useState<{ url: string; changes: GitChanges } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);
  // The newest read. One it overtook answers with it: Fetch counts the commits it
  // brought from its own read, which the read `git:changed` starts can overtake.
  const newest = useRef<{ id: number; url: string; read: Promise<GitChanges | null> } | null>(null);

  const refresh = useCallback((): Promise<GitChanges | null> => {
    if (!url || !projectName) return Promise.resolve(null);
    const id = ++requestId.current;
    const overtaken = () => {
      const next = newest.current;
      return next && next.id === requestId.current && next.url === url ? next.read : null;
    };
    const read = (async (): Promise<GitChanges | null> => {
      setLoading(true);
      try {
        const changes = await api.get<GitChanges>(url);
        if (id !== requestId.current) return overtaken();
        setLoaded({ url, changes });
        setError(null);
        const status = changesToStatus(changes);
        const store = useGitStatusStore.getState();
        store.setCount(projectName, changes.files.length);
        // The tree decorates by project-relative path; git answered in the repository's.
        store.setFileStatuses(projectName, rebaseStatus(status));
        store.setMeta(projectName, status);
        return changes;
      } catch (e) {
        if (id !== requestId.current) return overtaken();
        setError(e instanceof Error ? e.message : "Could not read the changes");
        return null;
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    })();
    newest.current = { id, url, read };
    return read;
  }, [url, projectName, rebaseStatus]);

  useEffect(() => {
    if (!url) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), EVENT_DELAY_MS);
    };
    const ours = (e: Event) => {
      if ((e as CustomEvent<{ projectName?: string }>).detail?.projectName === projectName) soon();
    };
    const visible = () => document.visibilityState === "visible";
    const onVisibility = () => { if (visible()) soon(); };
    void refresh();
    const poll = setInterval(() => { if (visible()) void refresh(); }, POLL_MS);
    window.addEventListener("git:changed", ours);
    window.addEventListener("file:changed", ours);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      requestId.current++;
      clearTimeout(timer);
      clearInterval(poll);
      window.removeEventListener("git:changed", ours);
      window.removeEventListener("file:changed", ours);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [url, projectName, refresh]);

  return {
    // Another repository's answer is not this one's, however recent.
    changes: loaded && loaded.url === url ? loaded.changes : null,
    error,
    loading,
    refresh,
  };
}
