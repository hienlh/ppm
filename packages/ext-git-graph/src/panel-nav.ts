/**
 * Navigation between this extension's panels.
 *
 * `createWebviewPanel` alone is not enough: the frontend only *creates a tab*
 * for a `webview:create` that some browser tab explicitly asked for
 * (`locallyDispatchedViews` in `use-extension-ws.ts`). A panel the extension
 * opens on its own initiative would exist server-side with no tab to show it.
 *
 * So navigation goes the other way round: ask the frontend to open an extension
 * tab for the target viewType. `extension-webview.tsx` then finds a tab with no
 * panel and dispatches the matching command itself — which *is* a local
 * dispatch, so the panel binds to the tab.
 *
 * That recovery dispatch only forwards the project path, so the actual target
 * (file to blame, refs to compare) is stashed here and picked up by the panel
 * when it opens. If the stash is empty the panel just shows its own picker.
 */
import type { ExtensionContext } from "@ppm/vscode-compat";
import type { VscodeApi } from "./git-exec.ts";
import { resolveProjectName } from "./ppm-api.ts";

const pendingTargets = new Map<string, unknown>();

function targetKey(viewType: string, projectPath: string): string {
  return `${viewType} ${projectPath}`;
}

export function setPendingTarget(viewType: string, projectPath: string, target: unknown): void {
  pendingTargets.set(targetKey(viewType, projectPath), target);
}

/** Read and clear the target a navigation left for this panel. */
export function takePendingTarget<T>(viewType: string, projectPath: string): T | undefined {
  const k = targetKey(viewType, projectPath);
  const value = pendingTargets.get(k) as T | undefined;
  pendingTargets.delete(k);
  return value;
}

export interface NavigateOptions {
  vscode: VscodeApi;
  context: ExtensionContext;
  /** Target viewType, identical to the command that opens it. */
  viewType: string;
  title: string;
  projectPath: string;
  /** Handed to the target panel via the stash. */
  target?: unknown;
}

export async function navigateToPanel(options: NavigateOptions): Promise<void> {
  const { vscode, context, viewType, title, projectPath, target } = options;
  if (target !== undefined) setPendingTarget(viewType, projectPath, target);
  const projectName = await resolveProjectName(projectPath);
  await vscode.window.openTab("extension", title, projectName, {
    viewType,
    extensionId: context.extensionId,
    projectName,
  });
}

/** Test seam. */
export function _resetPendingTargets(): void {
  pendingTargets.clear();
}
