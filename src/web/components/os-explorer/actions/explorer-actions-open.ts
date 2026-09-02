/**
 * Opening entries and the read-only menu commands: open in a PPM tab, open a folder in a
 * second explorer window, download, copy path / name.
 */

import { toast } from "sonner";
import type { FsEntry } from "@/lib/fs-api";
import { fsApi } from "@/lib/fs-api";
import { copyToClipboard } from "@/lib/clipboard";
import { triggerDownload } from "@/lib/file-download";
import { useTabStore } from "@/stores/tab-store";
import { useWindowStore } from "@/components/floating-window/window-store";
import { canOpenInPpm, viewerKindOf } from "../can-open-in-ppm";

/**
 * Open a file in the tab that can display it.
 *
 * `projectName` is deliberately absent: these are absolute host paths, and the viewers
 * branch on that to reach `/api/fs/*` instead of the project-scoped routes.
 */
export function openEntryInPpm(entry: FsEntry): boolean {
  if (!canOpenInPpm(entry.name)) return false;
  useTabStore.getState().openTab({
    type: viewerKindOf(entry.name) === "sqlite" ? "sqlite" : "editor",
    title: entry.name,
    projectId: null,
    metadata: { filePath: entry.path },
    closable: true,
  });
  return true;
}

/** Spawn another explorer window rooted at `path`. */
export function openPathInNewWindow(path: string): string {
  return useWindowStore.getState().open("explorer", { path });
}

/**
 * Download files one at a time. Each download needs its own single-use token, and
 * directories have no zip route outside a project, so folders are reported rather than
 * silently skipped.
 */
export async function downloadEntries(entries: FsEntry[]): Promise<void> {
  const files = entries.filter((e) => e.type === "file");
  const skipped = entries.length - files.length;
  if (skipped > 0) {
    toast.warning(skipped === 1 ? "Folders cannot be downloaded" : `${skipped} folders skipped`);
  }
  for (const file of files) {
    try {
      triggerDownload(await fsApi.downloadUrl(file.path), file.name);
    } catch (e) {
      toast.error(`Download failed: ${file.name}`, {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  }
}

/** Copy plain text to the system clipboard, one value per line, and confirm it. */
export async function copyTextLines(values: string[], noun: "Path" | "Name"): Promise<void> {
  if (values.length === 0) return;
  await copyToClipboard(values.join("\n"));
  toast.success(
    values.length === 1 ? `${noun} copied` : `${values.length} ${noun.toLowerCase()}s copied`,
  );
}
