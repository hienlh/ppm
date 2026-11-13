/**
 * The `shell` op of the Assistant e2e fixture: a shell call whose approved command really runs.
 *
 * The line is this PPM's own CLI (`currentPpmInstance().command`, as `ppm_cli_reference` tells the
 * model to invoke it) followed by the op's arguments. Once the card is approved it is spawned
 * through a shell, as both CLIs' shell tools run a command, with the environment the provider
 * would have handed it:
 *  - Claude: `claudeChildBaseEnv` — the base of what the Claude provider starts its CLI with, so
 *    what its Bash tool's commands inherit (the account and settings overrides add no PPM variable);
 *  - Codex: the allowlisted `buildSpawnEnv` plus `assistantShellEnv`, merged in that order as the
 *    Codex provider starts an Assistant session's app-server.
 * Nothing is mocked between the command and the server: the CLI finds the server through its
 * endpoint file and the hello, exactly as it would on a user's machine.
 */
import { currentPpmInstance } from "../../../src/services/assistant/ppm-cli-reference";
import { claudeChildBaseEnv } from "../../../src/providers/claude-agent-sdk";
import { buildSpawnEnv } from "../../../src/providers/codex-app-server/codex-jsonrpc-client";
import { assistantShellEnv } from "../../../src/services/assistant/assistant-shell-env";

export interface ShellRun { line: string; code: number; stdout: string; stderr: string; env: Record<string, string> }

const quoteArg = (a: string) => (/^[A-Za-z0-9_./:=@-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, "\\$1")}"`);

/** The command line the model would ask to run: this PPM's CLI and the arguments. */
export function ppmCommandLine(args: string[]): string {
  return [currentPpmInstance().command, ...args.map(quoteArg)].join(" ");
}

/** The environment the provider's shell would run the command with. */
export function providerShellEnv(providerId: string, assistantSession: boolean): Record<string, string> {
  const raw = providerId === "codex"
    ? { ...buildSpawnEnv(), ...(assistantSession ? assistantShellEnv() : {}) }
    : claudeChildBaseEnv({ assistantSession });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") env[k] = v;
  return env;
}

/** Runs `line` through the platform's shell in `cwd`, capturing both streams. */
export async function runShellLine(line: string, env: Record<string, string>, cwd: string): Promise<ShellRun> {
  const argv = process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", line] : ["/bin/sh", "-c", line];
  const proc = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 60_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { line, code, stdout, stderr, env };
  } finally {
    clearTimeout(timer);
  }
}
