import type { Command } from "commander";
import type { KillProcessResult, ProcessSignal, SignalProcessResult } from "../../types/system-metrics.ts";
import { PROCESS_SIGNALS } from "../../types/system-metrics.ts";
import { inAiChat } from "../../services/ai-chat-env.ts";
import { C, fail, run } from "./chat-cmd-request.ts";
import { freshSnapshot, systemRequest } from "./system-cmd-request.ts";

/**
 * `ppm system kill` and `ppm system signal`, through the Task Manager's own routes. The command
 * reads the pid's start time from a fresh process table and sends it with the request, so the
 * server's re-query refuses a pid that has since been reused; `--expect-name` is checked there
 * against the live name, so a wrong one ends nothing. From an AI chat `--expect-name` is required,
 * so the command line the user approves says WHAT it ends, not just a number — and the server
 * refuses a chat's own AI provider there (`chat_stop` stops a chat).
 */

export const EXPECT_NAME_REQUIRED =
  "From an AI chat, pass --expect-name <name> (as `ppm system processes` shows it), so the approved command says what it ends.";

export function parseSignal(raw: string): ProcessSignal {
  const name = raw.trim().toUpperCase().replace(/^SIG/, "") as ProcessSignal;
  if (!PROCESS_SIGNALS.includes(name)) fail(`Signal must be one of ${PROCESS_SIGNALS.join(", ")}`);
  return name;
}

function pidOf(raw: string): number {
  const pid = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(pid) || pid <= 0) fail("PID must be a positive integer");
  return pid;
}

interface TargetOptions { expectName?: string; tree?: boolean }

/** The body the routes check: the pid, the start time just seen for it, and the caller's claims. */
async function identityBody(pid: number, opts: TargetOptions): Promise<{ body: Record<string, unknown>; name: string }> {
  if (inAiChat() && !opts.expectName?.trim()) fail(EXPECT_NAME_REQUIRED);
  const snapshot = await freshSnapshot("full", 1);
  const row = snapshot.processes.find((p) => p.pid === pid);
  if (!row) fail(`PID ${pid} is not running`);
  const body: Record<string, unknown> = { pid, startedAt: row.startedAt, tree: opts.tree === true };
  if (opts.expectName !== undefined) body.expectName = opts.expectName;
  return { body, name: row.name };
}

export function registerSystemSignalCommands(system: Command): void {
  system
    .command("kill <pid>")
    .description("End a process: TERM, then KILL after a grace period (--force: KILL at once)")
    .option("--force", "Send KILL straight away")
    .option("--tree", "End its child processes too")
    .option("--expect-name <name>", "Refuse unless the process has this name (required from an AI chat)")
    .action((rawPid: string, opts: TargetOptions & { force?: boolean }) => run(async () => {
      const { body, name } = await identityBody(pidOf(rawPid), opts);
      if (opts.force) {
        const done = await systemRequest<SignalProcessResult>("POST", "/resources/signal", { ...body, signal: "KILL" });
        return void console.log(`${C.green}✓${C.reset} Sent KILL to ${name} (PID ${done.pid})${done.signalled.length > 1 ? ` and ${done.signalled.length - 1} more` : ""}`);
      }
      const done = await systemRequest<KillProcessResult>("POST", "/resources/kill", body);
      console.log(`${C.green}✓${C.reset} Ended ${name} (PID ${done.pid})${done.killed.length > 1 ? ` and ${done.killed.length - 1} more` : ""}`);
    })());

  system
    .command("signal <pid> <signal>")
    .description(`Send a signal to a process: ${PROCESS_SIGNALS.join(", ")} (Windows: TERM, KILL)`)
    .option("--tree", "Signal its child processes too")
    .option("--expect-name <name>", "Refuse unless the process has this name (required from an AI chat)")
    .action((rawPid: string, rawSignal: string, opts: TargetOptions) => run(async () => {
      const signal = parseSignal(rawSignal);
      const { body, name } = await identityBody(pidOf(rawPid), opts);
      const done = await systemRequest<SignalProcessResult>("POST", "/resources/signal", { ...body, signal });
      console.log(`${C.green}✓${C.reset} Sent ${signal} to ${name} (PID ${done.pid})${done.signalled.length > 1 ? ` and ${done.signalled.length - 1} more` : ""}`);
    })());
}
