/**
 * Boilerplate shared by every panel-opening command: resolve the project path
 * from the dispatch args (falling back to the PPM API), surface a readable
 * error when there is no project, and log failures with the command name.
 *
 * The command id must equal the panel's viewType — the frontend derives the tab
 * slug from both by stripping a trailing `.view`, and only creates the tab when
 * the two slugs match.
 */
import type { ExtensionContext } from "@ppm/vscode-compat";
import type { VscodeApi } from "./git-exec.ts";
import { resolveProjectPath } from "./ppm-api.ts";

export interface ViewCommandOptions {
  context: ExtensionContext;
  vscode: VscodeApi;
  /** Command id, identical to the viewType of the panel it opens. */
  command: string;
  /** Human label used in the "no project" error. */
  label: string;
  open: (projectPath: string, args: unknown[]) => void | Promise<void>;
}

export function registerViewCommand(options: ViewCommandOptions): void {
  const { context, vscode, command, label, open } = options;
  // registerCommand returns a structural { dispose() }, while subscriptions is
  // typed as the Disposable class; they are interchangeable at runtime.
  context.subscriptions.push(
    vscode.commands.registerCommand(command, async (...args: unknown[]) => {
      const projectPath = args[0] as string | undefined;
      const resolvedPath = projectPath || await resolveProjectPath();
      if (!resolvedPath) {
        console.warn(`[ext-git-graph] ${command}: no project path resolved`);
        await vscode.window.showErrorMessage(
          `${label}: No project selected. Open a project first, then try again.`,
        );
        return;
      }
      try {
        await open(resolvedPath, args);
      } catch (e) {
        console.error(`[ext-git-graph] ${command} failed:`, e);
        await vscode.window.showErrorMessage(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }) as unknown as (typeof context.subscriptions)[number],
  );
}
