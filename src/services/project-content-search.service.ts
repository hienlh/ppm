import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";

interface ResolverOptions {
  platform?: string;
  which?: (name: string) => string | null;
  exists?: (path: string) => Promise<boolean>;
  programFiles?: string;
  programFilesX86?: string;
}

/** Git for Windows ships GNU grep even when its usr/bin is absent from PATH. */
export async function resolveProjectSearchGrep(options: ResolverOptions = {}): Promise<string | undefined> {
  const which = options.which ?? ((name: string) => Bun.which(name));
  const direct = which("grep");
  if (direct) return direct;
  if ((options.platform ?? process.platform) !== "win32") return;
  const exists = options.exists ?? (async (path: string) => { try { await access(path); return true; } catch { return false; } });
  const git = which("git");
  const roots = git ? [resolve(dirname(git), ".."), resolve(dirname(git), "../..")] : [];
  for (const base of [options.programFiles ?? process.env.ProgramFiles, options.programFilesX86 ?? process.env["ProgramFiles(x86)"]]) {
    if (base) roots.push(resolve(base, "Git"));
  }
  for (const root of roots) {
    const candidate = resolve(root, "usr/bin/grep.exe");
    if (await exists(candidate)) return candidate;
  }
}

/** The program a search runs, and which one it is: their flags differ. */
export interface ProjectSearchTool { kind: "rg" | "grep"; path: string }

/**
 * ripgrep when it is installed, GNU grep otherwise. ripgrep searches on every core, grep on one:
 * on nxsys-workspace (181k entries) one query took grep 1.7 s — 11 s from a cold disk cache, past
 * the timeout — and ripgrep 0.1 s, for the same 38,071 lines.
 */
export async function resolveProjectSearchTool(options: ResolverOptions = {}): Promise<ProjectSearchTool | undefined> {
  const rg = (options.which ?? ((name: string) => Bun.which(name)))("rg");
  if (rg) return { kind: "rg", path: rg };
  const grep = await resolveProjectSearchGrep(options);
  return grep ? { kind: "grep", path: grep } : undefined;
}
