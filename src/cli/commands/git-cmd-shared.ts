import { resolve } from "node:path";
import type { Command } from "commander";
import { hideRemoteUrls } from "../../shared/hide-remote-urls.ts";
import { apiRequest, projectApiPath, type ApiQuery } from "../utils/project-route.ts";

/**
 * What every `ppm git` command shares. Each one calls the project's git route that Source Control
 * calls — through the running PPM that holds the database, so the route's checks apply and every
 * open git surface refreshes on its `git:changed`; only when no PPM holds the database is the same
 * route run inside this process, after the direct-write notice.
 *
 * Errors pass through `hideRemoteUrls`: git repeats a remote's URL, token and all, in its own
 * messages, and this output is often read by an AI chat's shell.
 */

export const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

export interface GitOpts {
  project?: string;
  repo?: string;
  json?: boolean;
}

/** Network commands wait longer than a local one: a fetch or push can take a while. */
export const REMOTE_TIMEOUT_MS = 5 * 60_000;

/** `-p`, `--repo` and `--json`, which every `ppm git` command takes. */
export function gitCommand(parent: Command, spec: string, description: string): Command {
  return parent
    .command(spec)
    .description(description)
    .option("-p, --project <name>", "Project name or path (default: the project the current folder is in)")
    .option("--repo <path>", "A repository inside the project, when the project folder holds several")
    .option("--json", "Print the route's answer as JSON");
}

export function fail(message: string): never {
  console.error(`${C.red}Error:${C.reset} ${hideRemoteUrls(message)}`);
  process.exit(1);
}

/** Runs a command's work, printing any failure (remote URLs hidden) and exiting 1. */
export async function act(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (e) {
    fail((e as Error).message);
  }
}

/** The project's git route `sub`, scoped to `--repo` when given (resolved here, where it was typed). */
export async function gitRequest<T>(
  method: string, opts: GitOpts, sub: string, body?: unknown, query: ApiQuery = {}, timeoutMs?: number,
): Promise<T> {
  const { currentProjectName } = await import("./chat-cmd-request.ts");
  const project = await currentProjectName(opts.project);
  const repo = opts.repo ? resolve(opts.repo) : undefined;
  return apiRequest<T>(method, projectApiPath(project, `git/${sub}`, { ...query, repo }), body, timeoutMs ? { timeoutMs } : {});
}

/** The route's answer as JSON with `--json`, else the short line. */
export function report(opts: GitOpts, data: unknown, line: string): void {
  if (opts.json) console.log(JSON.stringify(data, null, 2));
  else console.log(line);
}
