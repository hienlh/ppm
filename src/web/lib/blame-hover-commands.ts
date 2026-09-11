/**
 * The commands behind the blame hover's buttons.
 *
 * A Monaco hover can only contain markdown, so a button is a `command:` link
 * and there has to be something registered under that id for it to reach. These
 * are registered on the standalone `CommandsRegistry`, which is global to the
 * page — hence the idempotence, and hence ids namespaced under `ppm.blame.`.
 *
 * Three of the four hand off to the Git Graph extension, which already has the
 * views: `ext:command:execute` is the same event core UI uses elsewhere
 * (`git-status-panel.tsx`), and `git-graph.blame` and `git-graph.fileHistory`
 * already accept a file path as their second argument.
 *
 * Every handler re-checks its arguments even though `buildBlameHoverMarkdown`
 * is the only thing that writes these links, and even though the hover's trust
 * is narrowed so a commit message cannot forge one. The registry is global: any
 * other markdown on the page could name these ids.
 */
import type * as MonacoType from "monaco-editor";
import { toast } from "sonner";
import { copyToClipboard } from "./clipboard";

let registered = false;

/** Dispatch an extension command the way the rest of the app does. */
function runExtensionCommand(command: string, args: unknown[]): void {
  window.dispatchEvent(new CustomEvent("ext:command:execute", { detail: { command, args } }));
}

function asHash(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{7,40}$/.test(value) ? value : null;
}

function asPath(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Both paths are required. An extension view command reads a falsy first
 * argument as "resolve the project yourself", which for a hover that named a
 * specific file would silently open some other project's history.
 */
function runForFile(command: string, projectPath: unknown, filePath: unknown): void {
  const root = asPath(projectPath);
  const path = asPath(filePath);
  if (!root || !path) return;
  runExtensionCommand(command, [root, path]);
}

export function registerBlameHoverCommands(monaco: typeof MonacoType): void {
  if (registered) return;
  registered = true;

  monaco.editor.registerCommand("ppm.blame.copySha", (_accessor, hash: unknown) => {
    const sha = asHash(hash);
    if (!sha) return;
    // The full hash, not the abbreviation the link shows: an abbreviation is
    // for reading, and what you paste into a command has to be unambiguous.
    void copyToClipboard(sha).then((ok) => {
      toast[ok ? "success" : "error"](ok ? `Copied ${sha.slice(0, 7)}` : "Could not copy");
    });
  });

  monaco.editor.registerCommand("ppm.blame.fileHistory", (_accessor, projectPath: unknown, filePath: unknown) => {
    runForFile("git-graph.fileHistory", projectPath, filePath);
  });

  monaco.editor.registerCommand("ppm.blame.blameFile", (_accessor, projectPath: unknown, filePath: unknown) => {
    runForFile("git-graph.blame", projectPath, filePath);
  });

  monaco.editor.registerCommand("ppm.blame.showInGraph", (_accessor, projectPath: unknown) => {
    const root = asPath(projectPath);
    if (!root) return;
    runExtensionCommand("git-graph.view", [root]);
  });
}

/** Test seam. */
export function _resetBlameHoverCommands(): void {
  registered = false;
}
