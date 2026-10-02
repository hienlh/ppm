/**
 * The best entries of a project whose file list is too long to send to the browser
 * (`indexRemote`), searched on the server for `query` — for the palette and the pickers, which
 * would otherwise filter `fileIndex` themselves. They still rank what comes back as they rank a
 * list they hold; the server only saves them from holding 175k entries to find the best 100.
 *
 * What was last answered stays until the next answer lands, so typing does not blank the list,
 * and it asks again whenever an index lands (`indexRevision`) — the server's list moved.
 */
import { useEffect, useState } from "react";
import { api, projectUrl } from "@/lib/api-client";
import { useFileStore } from "@/stores/file-store";
import { REMOTE_FILE_SEARCH_LIMIT } from "../../shared/file-index-limits";
import type { FileEntry } from "../../types/project";

const NONE: FileEntry[] = [];

export function useRemoteFileSearch(
  projectName: string | null | undefined,
  query: string,
  { enabled, kind = "file" }: { enabled: boolean; kind?: "file" | "all" },
): FileEntry[] {
  const revision = useFileStore((s) => s.indexRevision);
  const [files, setFiles] = useState<FileEntry[]>(NONE);

  useEffect(() => {
    if (!enabled || !projectName) {
      setFiles(NONE);
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({ q: query, kind, limit: String(REMOTE_FILE_SEARCH_LIMIT) });
    api.get<FileEntry[]>(`${projectUrl(projectName)}/files/index/search?${params}`, { signal: controller.signal })
      .then(setFiles, () => { /* superseded by the next keystroke, or failed: keep what is shown */ });
    return () => controller.abort();
  }, [projectName, query, enabled, kind, revision]);

  return files;
}
