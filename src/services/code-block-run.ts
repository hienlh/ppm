/**
 * The Run button on a chat's shell code block: runs the block in the project folder and hands
 * back what it printed, shown under the block. Only the person clicking runs anything; the AI
 * cannot reach this (it is a browser route behind PPM's login, like the terminal it stands in for).
 *
 * The block goes to the user's own login shell (`$SHELL -lc`), so it sees the PATH a terminal
 * would. It is not interactive: no prompt, no `.zshrc` aliases, no stdin — a command waiting on
 * input reads end-of-file. The environment is a terminal's (`terminalEnv`): no AI-chat mark.
 */
import { runShell, type ShellRunResult } from "./shell-run.ts";
import { terminalEnv } from "./terminal.service.ts";

export const CODE_BLOCK_RUN_TIMEOUT_MS = 2 * 60_000;
export const CODE_BLOCK_MAX_CHARS = 16_000;

const isWindows = process.platform === "win32";

function codeBlockArgv(command: string): string[] {
  if (isWindows) return ["cmd.exe", "/d", "/s", "/c", `"${command}"`];
  return [process.env.SHELL || "/bin/sh", "-lc", command];
}

export function runCodeBlock(command: string, cwd: string, signal?: AbortSignal, timeoutMs = CODE_BLOCK_RUN_TIMEOUT_MS): Promise<ShellRunResult> {
  return runShell({
    argv: codeBlockArgv(command),
    cwd,
    env: terminalEnv({ ...process.env, TERM: "dumb", NO_COLOR: "1" }, false),
    timeoutMs,
    signal,
    windowsVerbatimArguments: isWindows,
  });
}
