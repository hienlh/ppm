/**
 * Shared git execution + argument validation.
 *
 * Every git argument that originates in a webview passes through one of the
 * assert* guards here before it reaches `spawn`. The guards reject leading
 * dashes (option injection), control characters, and paths that escape the
 * project root.
 */
import * as nodePath from "node:path";
import type { SpawnResult } from "@ppm/vscode-compat/src/process.ts";

export interface VscodeApi {
  commands: {
    registerCommand(command: string, callback: (...args: unknown[]) => unknown): { dispose(): void };
  };
  window: {
    showErrorMessage(message: string, ...items: string[]): Promise<string | undefined>;
    showInformationMessage(message: string, ...items: string[]): Promise<string | undefined>;
    showQuickPick?(items: unknown[], options?: unknown): Promise<unknown>;
    openTab(tabType: string, title: string, projectId: string | null, metadata?: Record<string, unknown>): Promise<void>;
    switchProject(projectName: string): Promise<void>;
    createWebviewPanel(viewType: string, title: string, showOptions: unknown, options?: { projectPath?: string }): {
      webview: {
        html: string;
        onDidReceiveMessage: (listener: (msg: unknown) => void) => { dispose(): void };
        postMessage(message: unknown): Promise<boolean>;
      };
      onDidDispose: (listener: () => void) => { dispose(): void };
      dispose(): void;
    };
  };
  process: {
    spawn(cmd: string, args: string[], cwd: string, options?: { timeout?: number; env?: Record<string, string> }): Promise<SpawnResult>;
  };
  workspace: {
    fs: {
      readFile(uri: { fsPath: string }): Promise<Uint8Array>;
      stat(uri: { fsPath: string }): Promise<{ type: number; size: number; mtime: number }>;
    };
  };
  Uri: { file(path: string): { fsPath: string } };
  ViewColumn: { Active: number };
}

export type ExtWebviewPanel = ReturnType<VscodeApi["window"]["createWebviewPanel"]>;

/** Spawn git and return result */
export async function spawnGit(
  vscode: VscodeApi,
  args: string[],
  cwd: string,
  timeout = 30_000,
  extraEnv?: Record<string, string>,
): Promise<SpawnResult> {
  return vscode.process.spawn("git", args, cwd, {
    timeout,
    env: { GIT_TERMINAL_PROMPT: "0", ...extraEnv },
  });
}

export function assertValidHash(value: unknown): string {
  const s = String(value || "");
  if (s === "HEAD") return s;
  if (!/^[0-9a-f]{4,40}$/i.test(s)) throw new Error(`Invalid commit hash: "${s}"`);
  return s;
}

export function assertValidRef(value: unknown, label: string): string {
  const s = String(value || "");
  if (!s || /[\x00-\x1f\x7f~^:?*[\]\\]/.test(s) || s.startsWith("-") || s.includes("..")) {
    throw new Error(`Invalid git ref for ${label}: "${s}"`);
  }
  return s;
}

export function assertValidRemote(value: unknown): string {
  const s = String(value || "");
  if (!s || /[\x00-\x1f\x7f]/.test(s) || s.startsWith("-")) {
    throw new Error(`Invalid remote name: "${s}"`);
  }
  return s;
}

/**
 * The part of `node:path` the guard below needs. It is a parameter because the
 * separator decides whether the guard accepts a path or rejects it, so a test
 * running on one platform says nothing about the other.
 */
type PathApi = Pick<typeof nodePath, "resolve" | "relative" | "isAbsolute" | "sep">;

/** Validate file paths are relative and don't escape the project root */
export function assertSafeFilePaths(
  files: string[],
  projectPath: string,
  path: PathApi = nodePath,
): void {
  for (const f of files) {
    if (!f || f.startsWith("-") || path.isAbsolute(f) || /[\x00-\x1f\x7f]/.test(f)) {
      throw new Error(`Invalid file path: "${f}"`);
    }
    // Containment is asked of `relative`, not of a string prefix. Comparing a
    // resolved path against `normalize(projectPath) + "/"` rejected *every*
    // path on Windows, where `resolve` answers with backslashes and the root
    // built with a forward slash therefore never matched — the whole extension
    // was unusable there, with a message blaming the file.
    const rel = path.relative(projectPath, path.resolve(projectPath, f));
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`File path escapes project root: "${f}"`);
    }
  }
}

/**
 * A positive 1-based line number, for `git blame -L` / `git log -L`.
 * Anything non-integer would otherwise be interpolated straight into an
 * argument that git parses as a range expression.
 */
export function assertValidLineNumber(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid line number for ${label}: "${String(value)}"`);
  return n;
}
