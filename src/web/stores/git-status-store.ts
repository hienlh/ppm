import { useCallback, useEffect } from "react";
import { create } from "zustand";
import { api, projectUrl } from "@/lib/api-client";
import type { GitStatus } from "../../types/git";

interface GitStatusStore {
  /** Total changed files count per project (staged + unstaged + untracked) */
  counts: Map<string, number>;
  setCount: (projectName: string, count: number) => void;
}

export const useGitStatusStore = create<GitStatusStore>()((set) => ({
  counts: new Map(),
  setCount: (projectName, count) => {
    set((state) => {
      if (state.counts.get(projectName) === count) return state;
      const next = new Map(state.counts);
      next.set(projectName, count);
      return { counts: next };
    });
  },
}));

/**
 * Polls git status count in the background so the sidebar badge stays fresh.
 * Skips polling when GitStatusPanel is mounted (it has its own 5s poll).
 */
export function useGitChangesPoller(
  projectName: string | undefined,
  skip?: boolean,
) {
  const setCount = useGitStatusStore((s) => s.setCount);

  const poll = useCallback(async () => {
    if (!projectName) return;
    try {
      const data = await api.get<GitStatus>(
        `${projectUrl(projectName)}/git/status`,
      );
      setCount(
        projectName,
        data.staged.length + data.unstaged.length + data.untracked.length,
      );
    } catch {
      // Silently ignore — badge just keeps last-known value
    }
  }, [projectName, setCount]);

  useEffect(() => {
    if (skip) return;
    poll();
    const interval = setInterval(poll, 10_000);
    return () => clearInterval(interval);
  }, [poll, skip]);
}
