import { openExplorer } from "@/components/os-explorer/open-explorer";
import { MOBILE_EXPLORER_WINDOW_ID } from "@/components/os-explorer/use-explorer-open-state";
import type { AssistantOpenFileBrowserResult } from "../../../shared/assistant-ui-protocol";

/**
 * `open_file_browser` on the device: the OS file browser at the folder the server resolved, with
 * the file it resolved selected — a floating window on a desktop, the full-screen sheet on a
 * phone. The server already held the path to its rules; this side only checks the shape.
 */
export async function openAssistantFileBrowser(args: Record<string, unknown>): Promise<AssistantOpenFileBrowserResult> {
  const dir = typeof args.dir === "string" && args.dir ? args.dir : null;
  const select = typeof args.select === "string" && args.select ? args.select : null;
  if (!dir) throw new Error("`dir` must be the folder the server resolved.");
  const id = await openExplorer(dir, { select });
  if (!id) throw new Error("The file browser could not open.");
  return { dir, select, surface: id === MOBILE_EXPLORER_WINDOW_ID ? "sheet" : "window" };
}
