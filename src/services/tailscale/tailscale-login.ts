/**
 * Signing this machine in to Tailscale from the settings pane: `tailscale up --json`
 * prints the sign-in link (and a QR code) as JSON, then `{"BackendState":"Running"}` once
 * the person has finished in their browser, and exits.
 *
 * Two traps in that command. `tailscale up` refuses to run when the node already has
 * settings the command line does not repeat ("changing settings via 'tailscale up'
 * requires mentioning all non-default flags"), so a node signed in before (an operator, a
 * tag, a hostname) cannot simply be signed in again with `tailscale up`. The refusal
 * prints the exact command that keeps every current setting, which is retried once.
 * And a node that is merely turned off must get a *bare* `tailscale up`: any flag,
 * `--json` included, takes it off that path and into the same refusal.
 *
 * One sign-in at a time; a second start while one is waiting returns it. Every terminal
 * state drops the process, so the next start gets a fresh link.
 */
import { broadcastGlobalEvent } from "../../server/ws/global.ts";
import { hostCli, isAccessDenied, runJson, type TailscaleCli } from "./tailscale-cli.ts";
import { parseStatus } from "./tailscale-state.ts";
import type { TailscaleLoginSnapshot, TailscaleLoginState } from "../../shared/tailscale-setup.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("tailscale");

export const LOGIN_TIMEOUT_MS = 10 * 60_000;

const spawnCli = (argv: string[]) =>
  Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true });

interface Session extends TailscaleLoginSnapshot {
  proc: ReturnType<typeof spawnCli> | null;
  killTimer: ReturnType<typeof setTimeout> | null;
}

let session: Session = { state: "idle", url: null, message: null, proc: null, killTimer: null };

export function getLoginSnapshot(): TailscaleLoginSnapshot {
  return { state: session.state, url: session.url, message: session.message };
}

function announce(): void {
  broadcastGlobalEvent({ type: "tailscale:changed", login: getLoginSnapshot() });
}

function finish(state: TailscaleLoginState, message: string | null): void {
  const pid = session.proc?.pid;
  if (session.killTimer) clearTimeout(session.killTimer);
  session = { state, url: null, message, proc: null, killTimer: null };
  announce();
  // The broadcast reaches only an open pane; this is the record of how the sign-in ended.
  // Any link in the message is dropped: a sign-in link would let whoever opens it take the
  // machine into their own tailnet.
  const of = pid ? ` (PID ${pid})` : "";
  const text = message ? `: ${message.replace(/https?:\/\/\S+/g, "<link>")}` : "";
  if (state === "timeout") log.warn(`Tailscale sign-in timed out after ${LOGIN_TIMEOUT_MS / 60_000}m${of}`);
  else if (state === "error" || state === "needs-operator") log.error(`Tailscale sign-in ${state}${of}${text}`);
  else log.info(`Tailscale sign-in ${state}${of}${text}`);
}

/** Split one shell command line the way `shellquote.Join` built it (POSIX quoting). */
export function splitShellWords(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      word += line.slice(i + 1, end === -1 ? line.length : end);
      i = end === -1 ? line.length : end;
      inWord = true;
    } else if (ch === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < line.length) i++;
        word += line[i];
        i++;
      }
      inWord = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      word += line[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

/** The flags `tailscale up` asked to be repeated, or null when it refused for another reason. */
export function flagsFromRevertRefusal(stderr: string): string[] | null {
  if (!/requires mentioning all\s+non-default flags/.test(stderr)) return null;
  const line = stderr.match(/\n\s*tailscale up([^\n]*)/)?.[1];
  if (line === undefined) return null;
  const flags = splitShellWords(line).filter((w) => w.startsWith("--"));
  return flags.includes("--json") ? flags : ["--json", ...flags];
}

/**
 * Pull complete JSON objects off the front of `buffer` (`tailscale up --json` writes them
 * indented, one after another).
 */
export function takeJsonObjects(buffer: string): { objects: unknown[]; rest: string } {
  const objects: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let consumed = 0;
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        try { objects.push(JSON.parse(buffer.slice(start, i + 1))); } catch { /* not ours */ }
        consumed = i + 1;
        start = -1;
      }
    }
  }
  return { objects, rest: buffer.slice(consumed) };
}

/** What a failed `tailscale up` means for the person in front of the pane. */
export function loginFailure(stderr: string): { state: TailscaleLoginState; message: string } {
  if (isAccessDenied(stderr)) {
    return { state: "needs-operator", message: "Tailscale refused to let PPM sign this machine in." };
  }
  const text = stderr.trim().split("\n").filter(Boolean).slice(0, 3).join(" ");
  return { state: "error", message: text || "tailscale up exited without signing in" };
}

async function readBackendState(cli: TailscaleCli): Promise<string | null> {
  if (!cli.argv) return null;
  const status = await runJson(cli.runner, [...cli.argv, "status", "--json"]).catch(() => null);
  return status ? parseStatus(status).backendState : null;
}

/** Turn a signed-in machine that was switched off back on. */
async function turnOn(cli: TailscaleCli): Promise<void> {
  const current = session;
  const result = await cli.runner([...cli.argv!, "up"], 30_000);
  if (session !== current) return; // cancelled meanwhile; a newer sign-in may be running
  if (result.code === 0) finish("success", "Tailscale is on");
  else {
    const failure = loginFailure(result.stderr);
    finish(failure.state, failure.message);
  }
}

function runInteractive(cli: TailscaleCli, flags: string[], retried: boolean): void {
  const proc = spawnCli([...cli.argv!, "up", ...flags]);
  session.proc = proc;
  // Flag names only: a value is a setting of this node, and nothing a log reader needs.
  log.info(retried
    ? `Tailscale sign-in retried with the node's current flags (${flags.map((f) => f.split("=")[0]).join(" ")}) (PID ${proc.pid})`
    : `Tailscale sign-in started (PID ${proc.pid})`);

  const stdoutDone = (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const taken = takeJsonObjects(pending + decoder.decode(value, { stream: true }));
        pending = taken.rest;
        for (const object of taken.objects) {
          if (session.proc !== proc) return;
          const o = object as { AuthURL?: unknown; BackendState?: unknown; Error?: unknown };
          if (typeof o.AuthURL === "string" && o.AuthURL) {
            session.state = "waiting";
            session.url = o.AuthURL;
            announce();
          } else if (o.BackendState === "Running") {
            finish("success", "Signed in");
          } else if (o.BackendState === "NeedsMachineAuth") {
            finish("needs-approval", "An admin has to approve this machine in Tailscale.");
          } else if (typeof o.Error === "string" && o.Error) {
            finish("error", o.Error);
          }
        }
      }
    } catch { /* killed */ }
  })();
  const stderrText = new Response(proc.stderr).text().catch(() => "");

  void Promise.all([proc.exited, stdoutDone, stderrText]).then(([code, , stderr]) => {
    if (session.proc !== proc) return;
    if (code === 0) { finish("success", "Signed in"); return; }
    const retry = retried ? null : flagsFromRevertRefusal(stderr);
    if (retry) { runInteractive(cli, retry, true); return; }
    const failure = loginFailure(stderr);
    finish(failure.state, failure.message);
  });
}

/** Start (or return the running) sign-in. */
export async function startLogin(cli: TailscaleCli = hostCli()): Promise<TailscaleLoginSnapshot> {
  if (session.state === "starting" || session.state === "waiting") return getLoginSnapshot();
  if (!cli.argv) {
    finish("error", "Tailscale is not installed on this machine.");
    return getLoginSnapshot();
  }
  const current: Session = { state: "starting", url: null, message: null, proc: null, killTimer: null };
  session = current;
  announce();

  const backend = await readBackendState(cli);
  // The object, not its state: a cancel and a new start meanwhile leave a session that is
  // "starting" too, and carrying on would give it a second `tailscale up` and kill timer.
  if (session !== current) return getLoginSnapshot();
  if (backend === "Running") { finish("success", "Already signed in"); return getLoginSnapshot(); }
  if (backend === "NeedsMachineAuth") {
    finish("needs-approval", "An admin has to approve this machine in Tailscale.");
    return getLoginSnapshot();
  }
  if (backend === "Stopped") { await turnOn(cli); return getLoginSnapshot(); }

  session.killTimer = setTimeout(() => {
    try { session.proc?.kill(); } catch { /* gone */ }
    finish("timeout", "The sign-in link expired. Start again for a new one.");
  }, LOGIN_TIMEOUT_MS);
  runInteractive(cli, ["--json"], false);
  return getLoginSnapshot();
}

export function cancelLogin(): TailscaleLoginSnapshot {
  if (session.proc) {
    try { session.proc.kill(); } catch { /* gone */ }
  }
  finish("cancelled", null);
  return getLoginSnapshot();
}

// A sign-in left running would keep a stale link alive after the server is gone.
process.on("exit", () => {
  try { session.proc?.kill(); } catch { /* gone */ }
});

/** The seam route tests patch, as `cloudflaredLoginService` is. */
export const tailscaleLoginService = { getLoginSnapshot, startLogin, cancelLogin };
