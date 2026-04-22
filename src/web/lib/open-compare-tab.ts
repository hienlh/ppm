import { api, projectUrl } from "@/lib/api-client";
import { useTabStore } from "@/stores/tab-store";
import { basename } from "@/lib/utils";

/** One side of a compare — path + optional in-memory dirty buffer. */
export interface CompareSide {
  path: string;
  dirtyContent?: string;
}

/**
 * Open a `git-diff` tab comparing two files.
 *
 * Routing:
 * - If either side has `dirtyContent` → fetch clean side via `/files/read`
 *   and pass `original`+`modified` inline (DiffViewer's inline mode).
 * - Else → pass `file1`+`file2` metadata (DiffViewer fetches `/files/compare`).
 *
 * Returns the new tab id.
 */
export async function openCompareTab(
  a: CompareSide,
  b: CompareSide,
  projectName: string,
): Promise<string> {
  const title = `${basename(a.path)} ↔ ${basename(b.path)}`;
  const aDirty = a.dirtyContent !== undefined;
  const bDirty = b.dirtyContent !== undefined;

  let metadata: Record<string, unknown>;

  if (aDirty || bDirty) {
    const [original, modified] = await Promise.all([
      resolveSideContent(a, projectName),
      resolveSideContent(b, projectName),
    ]);
    // Inline mode — DiffViewer uses `original`/`modified` when present
    // (see diff-viewer.tsx:36 `isInline` check).
    metadata = {
      projectName,
      original,
      modified,
      // Keep paths around for future needs (copy path, re-open source, etc.).
      file1: a.path,
      file2: b.path,
    };
  } else {
    metadata = {
      projectName,
      file1: a.path,
      file2: b.path,
    };
  }

  const id = useTabStore.getState().openTab({
    type: "git-diff",
    title,
    projectId: projectName,
    metadata,
    closable: true,
  });
  return id;
}

async function resolveSideContent(side: CompareSide, projectName: string): Promise<string> {
  if (side.dirtyContent !== undefined) return side.dirtyContent;
  try {
    const { content } = await api.get<{ content: string }>(
      `${projectUrl(projectName)}/files/read?path=${encodeURIComponent(side.path)}`,
    );
    return content;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read "${side.path}": ${reason}`);
  }
}
