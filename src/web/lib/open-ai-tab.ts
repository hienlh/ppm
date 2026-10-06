import { usePanelStore } from "@/stores/panel-store";
import { useProjectStore } from "@/stores/project-store";
import { absoluteProjectPath, relativeProjectPath } from "@/stores/file-store";
import { fsApi } from "@/lib/fs-api";
import { basename } from "@/lib/utils";
import { chooseAiTabPlacement, isTabForFile } from "./ai-tab-placement";
import { latestPreviewLoad, previewKey, waitForPreviewLoad } from "./html-preview-loads";
import type { TabOpenRequest, TabOpenResult, TabTool } from "../../shared/tab-open-protocol";

/**
 * Opens the tab the AI asked for with `open_file` or `open_preview`, beside the chat that
 * asked (`ai-tab-placement.ts` decides where), and answers the server's `tab_open`. A tool
 * card's Open button goes through the same {@link openAiTab}, so a tab reopened from the
 * chat's history lands where the AI's own call put it.
 *
 * The editor reads `aiView` and `aiOpenAt` from the tab's metadata: every call switches the
 * view the tool asked for and reloads a preview, also in a tab that was already open.
 */

/** A file as a PPM tab names it. */
export interface AiTabTarget {
  tool: TabTool;
  /** Relative to `projectName`'s folder, or absolute outside it. */
  filePath: string;
  projectName: string | null;
  /** 1-based; the file opens as code at this line. */
  line?: number;
}

export interface AiTabChat {
  sessionId: string;
  /** The chat's project. The tab opens in its workspace, which is brought up first. */
  projectName: string | undefined;
}

/** A preview whose page has not fired `load` by then (a slow CDN) is checked anyway. */
const PREVIEW_LOAD_WAIT_MS = 12_000;
/** After `load`, the page's own scripts still draw: charts, fonts, a framework's first render. */
const PREVIEW_SETTLE_MS = 1_500;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The workspace the chat belongs to, the way a notification for it brings it up. */
function showChatWorkspace(projectName: string | undefined): void {
  if (!projectName || usePanelStore.getState().currentProject === projectName) return;
  const project = useProjectStore.getState().projects.find((p) => p.name === projectName);
  if (!project) return;
  useProjectStore.getState().setActiveProject(project);
  // Right away rather than on the app's effect, so the tab lands in this project's layout.
  usePanelStore.getState().switchProject(projectName);
}

/**
 * Opens (or brings back) the file's tab. Returns the preview key the editor will load the
 * page under and the last load already seen there, so a caller can wait for the next one.
 */
export function openAiTab(target: AiTabTarget, chat: AiTabChat): { tabId: string; previewKey: string; before: number } {
  showChatWorkspace(chat.projectName);
  const store = usePanelStore.getState();
  const placement = chooseAiTabPlacement({
    grid: store.grid,
    panels: store.panels,
    focusedPanelId: store.focusedPanelId,
    mobile: store.isMobile(),
    sessionId: chat.sessionId,
    isTarget: (tab) => isTabForFile(tab, target.filePath, target.projectName),
  });
  if (!placement) throw new Error("PPM has no panel to open the tab in");

  const now = Date.now();
  const aiView = target.line ? "code" : target.tool === "open_preview" ? "preview" : undefined;
  const view: Record<string, unknown> = {
    ...(target.line ? { lineNumber: target.line, endLine: undefined, revealAt: now } : {}),
    ...(aiView ? { aiView, aiOpenAt: now } : {}),
  };

  if (placement.kind === "open") {
    const metadata = { filePath: target.filePath, ...(target.projectName ? { projectName: target.projectName } : {}), ...view };
    const key = previewKey(target.projectName ?? undefined, target.filePath);
    const before = latestPreviewLoad(key);
    const tabId = store.openTab(
      { type: "editor", title: basename(target.filePath), projectId: target.projectName, metadata, closable: true },
      placement.panelId,
    );
    if (!tabId) throw new Error("PPM could not open the tab");
    if (placement.split) store.splitPanel("right", tabId, placement.panelId);
    return { tabId, previewKey: key, before };
  }

  const fromPanelId = placement.kind === "focus" ? placement.panelId : placement.fromPanelId;
  const tab = store.panels[fromPanelId]?.tabs.find((t) => t.id === placement.tabId);
  const metadata = { ...tab?.metadata, ...view };
  const key = previewKey(metadata.projectName as string | undefined, String(metadata.filePath ?? target.filePath));
  const before = latestPreviewLoad(key);
  store.updateTab(placement.tabId, { metadata });
  if (placement.kind === "focus") {
    store.setActiveTab(placement.tabId, placement.panelId);
  } else if (placement.toPanelId) {
    store.moveTab(placement.tabId, fromPanelId, placement.toPanelId);
  } else if (!store.splitPanel("right", placement.tabId, fromPanelId)) {
    store.setActiveTab(placement.tabId, fromPanelId);
  }
  return { tabId: placement.tabId, previewKey: key, before };
}

/**
 * Answers the server's `tab_open`: opens the tab and, for a page the AI made, waits for it to
 * load and settle and returns the check of how it rendered. Every outcome is answered — a
 * silent device would leave the AI waiting for the server's timeout.
 */
export async function answerTabOpen(req: TabOpenRequest, chat: AiTabChat, send: (data: string) => void): Promise<void> {
  const reply = (answer: Omit<TabOpenResult, "type" | "requestId">): void => {
    const result: TabOpenResult = { type: "tab_open_result", requestId: req.requestId, ...answer };
    send(JSON.stringify(result));
  };
  let opened: ReturnType<typeof openAiTab>;
  try {
    opened = openAiTab({ tool: req.tool, filePath: req.filePath, projectName: req.projectName, line: req.line }, chat);
  } catch (e) {
    reply({ opened: false, error: errorText(e) });
    return;
  }
  if (!req.check) {
    reply({ opened: true });
    return;
  }
  try {
    const load = await waitForPreviewLoad(opened.previewKey, opened.before, PREVIEW_LOAD_WAIT_MS);
    if (!load) {
      reply({ opened: true, error: "the page did not start loading" });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, PREVIEW_SETTLE_MS));
    const frame = usePanelStore.getState().isMobile() ? "Phone" : "Desktop";
    reply({ opened: true, report: await load.check({ screenshot: req.check.screenshot, frame }) });
  } catch (e) {
    reply({ opened: true, error: errorText(e) });
  }
}

/**
 * The tab a tool card's Open button opens, from the call's own `path`: resolved on the host
 * (it may start with `~`), and named relative to the chat's project when it lies inside it, so
 * it is the same tab the AI's call opened.
 */
export async function resolveToolCallTarget(
  call: { tool: TabTool; path: string; line?: number },
  projectName: string | undefined,
): Promise<AiTabTarget> {
  const root = projectName ? useProjectStore.getState().projects.find((p) => p.name === projectName)?.path : undefined;
  const raw = call.path.trim();
  const absolute = /^(\/|[a-z]:[/\\]|~(?:[/\\]|$))/i.test(raw);
  if (!absolute && !root) throw new Error("this chat has no project folder");
  const entry = await fsApi.stat(absolute ? raw : absoluteProjectPath(root!, raw));
  if (entry.kind === "directory") throw new Error(`${raw} is a folder`);
  const relative = root ? relativeProjectPath(root, entry.path) : null;
  return relative
    ? { tool: call.tool, filePath: relative, projectName: projectName!, line: call.line }
    : { tool: call.tool, filePath: entry.path, projectName: null, line: call.line };
}
