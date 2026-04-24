import { useCallback, useEffect } from "react";
import { create } from "zustand";
import { api, projectUrl } from "@/lib/api-client";
import type { GitStatus } from "../../types/git";

/** Git status letter for file tree decorations */
export type GitFileStatus = "M" | "A" | "D" | "R" | "C" | "U";

/** Colors matching git-status-panel.tsx STATUS_COLORS */
export const GIT_STATUS_COLORS: Record<GitFileStatus, string> = {
  M: "text-yellow-500",
  A: "text-green-500",
  D: "text-red-500",
  R: "text-blue-500",
  C: "text-purple-500",
  U: "text-gray-400",
};

/** Per-project file status map: filePath → status letter */
type FileStatusMap = Map<string, GitFileStatus>;

interface GitStatusStore {
  /** Total changed files count per project (staged + unstaged + untracked) */
  counts: Map<string, number>;
  /** Per-file git status for tree decorations: projectName → (filePath → status) */
  fileStatuses: Map<string, FileStatusMap>;
  /** Per-folder aggregate status: projectName → (folderPath → status) */
  folderStatuses: Map<string, Map<string, GitFileStatus>>;

  setCount: (projectName: string, count: number) => void;
  setFileStatuses: (projectName: string, data: GitStatus) => void;
}

/**
 * Compute per-file status map from GitStatus response.
 * Priority: staged > unstaged > untracked.
 */
function buildFileStatusMap(data: GitStatus): FileStatusMap {
  const map: FileStatusMap = new Map();
  // Untracked first (lowest priority)
  for (const path of data.untracked) {
    map.set(path, "U");
  }
  // Unstaged overrides untracked
  for (const change of data.unstaged) {
    const status = change.status === "?" ? "U" : change.status as GitFileStatus;
    map.set(change.path, status);
  }
  // Staged overrides unstaged
  for (const change of data.staged) {
    const status = change.status === "?" ? "U" : change.status as GitFileStatus;
    map.set(change.path, status);
  }
  return map;
}

/**
 * Compute folder aggregate statuses from file statuses.
 * A folder gets the "most significant" status of any descendant.
 * Priority: D > A > M > R > C > U
 */
function buildFolderStatusMap(fileMap: FileStatusMap): Map<string, GitFileStatus> {
  const priority: Record<GitFileStatus, number> = { D: 5, A: 4, M: 3, R: 2, C: 1, U: 0 };
  const folders = new Map<string, GitFileStatus>();

  for (const [filePath, status] of fileMap) {
    const parts = filePath.split("/");
    // Walk parent paths: "src", "src/web", "src/web/hooks"
    for (let i = 1; i < parts.length; i++) {
      const folderPath = parts.slice(0, i).join("/");
      const existing = folders.get(folderPath);
      if (!existing || priority[status] > priority[existing]) {
        folders.set(folderPath, status);
      }
    }
  }
  return folders;
}

export const useGitStatusStore = create<GitStatusStore>()((set) => ({
  counts: new Map(),
  fileStatuses: new Map(),
  folderStatuses: new Map(),

  setCount: (projectName, count) => {
    set((state) => {
      if (state.counts.get(projectName) === count) return state;
      const next = new Map(state.counts);
      next.set(projectName, count);
      return { counts: next };
    });
  },

  setFileStatuses: (projectName, data) => {
    const fileMap = buildFileStatusMap(data);
    const folderMap = buildFolderStatusMap(fileMap);
    set((state) => {
      const nextFile = new Map(state.fileStatuses);
      nextFile.set(projectName, fileMap);
      const nextFolder = new Map(state.folderStatuses);
      nextFolder.set(projectName, folderMap);
      return { fileStatuses: nextFile, folderStatuses: nextFolder };
    });
  },
}));

/**
 * Polls git status in the background so sidebar badge + file decorations stay fresh.
 * Skips polling when GitStatusPanel is mounted (it has its own 5s poll).
 */
export function useGitChangesPoller(
  projectName: string | undefined,
  skip?: boolean,
) {
  const setCount = useGitStatusStore((s) => s.setCount);
  const setFileStatuses = useGitStatusStore((s) => s.setFileStatuses);

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
      setFileStatuses(projectName, data);
    } catch {
      // Silently ignore — badge just keeps last-known value
    }
  }, [projectName, setCount, setFileStatuses]);

  useEffect(() => {
    if (skip) return;
    poll();
    const interval = setInterval(poll, 10_000);
    return () => clearInterval(interval);
  }, [poll, skip]);
}
