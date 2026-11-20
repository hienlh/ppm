import type { Json } from "../mcp-http-endpoint.ts";
import { projectService } from "../project.service.ts";
import { resolveFileBrowserTarget, type FileBrowserTargetOptions } from "../file-browser-target.ts";
import type { AssistantOpenFileBrowserArgs, AssistantOpenFileBrowserResult } from "../../shared/assistant-ui-protocol.ts";
import { askDevice, assistantUiBroker, type UiRequest } from "./assistant-ui-tools.ts";
import { UI_NAV_WAIT_MS } from "./assistant-ui-nav-tools.ts";
import { errorResult, jsonResult } from "./assistant-tool-output.ts";

/**
 * `ui_open_file_browser`: opens the OS file browser — the File Explorer window on a desktop, the
 * full-screen sheet on a phone — on the chatting device, at any folder on this machine's drives;
 * a file opens its folder with the file selected. Unlike `ui_reveal_path` (one project's tree),
 * the path need not be in a project.
 *
 * Navigation only: nothing is read or written and the agent learns only that the path exists, so
 * no card. The path is held to `resolveFileBrowserTarget`'s rules — PPM's own folder, `~/.cloudflared`
 * and the stores the Assistant keeps private are refused before anything reaches the screen — and
 * the device is handed the folder and file the server resolved, never the agent's spelling.
 */

function openResult(data: unknown): AssistantOpenFileBrowserResult | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.dir !== "string" || (d.surface !== "window" && d.surface !== "sheet")) return null;
  return { dir: d.dir, select: typeof d.select === "string" ? d.select : null, surface: d.surface };
}

export async function uiOpenFileBrowser(
  sessionId: string,
  args: Record<string, unknown>,
  request: UiRequest = assistantUiBroker.request,
  deps: Pick<FileBrowserTargetOptions, "projectRoots" | "scope"> = {},
): Promise<Json> {
  const target = await resolveFileBrowserTarget(args.path, {
    projectRoots: deps.projectRoots ?? (() => projectService.list().map((p) => p.path)),
    ...(deps.scope ? { scope: deps.scope } : {}),
  });
  if (!target.ok) return errorResult(target.error);
  const body: AssistantOpenFileBrowserArgs = { dir: target.value.dir, select: target.value.select };
  const answer = await askDevice(request, sessionId, { op: "open_file_browser", args: { ...body } }, UI_NAV_WAIT_MS, "open the file browser");
  if (!answer.ok) return answer.result;
  const result = openResult(answer.data);
  if (!result) return errorResult("The device answered, but not with a result PPM understands; check with ui_get_state.");
  return jsonResult({ ...result, kind: target.value.kind });
}
