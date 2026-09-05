/**
 * Login session singleton behind the "log in to Cloudflare" popup.
 *
 * One process-per-machine at a time: a second `startLogin` call while one is
 * live (`waiting`/`slow`) just returns the current snapshot instead of
 * spawning a competing `cloudflared tunnel login`. Every terminal state
 * (`success`/`timeout`/`cancelled`/`error`) drops the process ref, so the
 * *next* call after a terminal state always starts a genuinely fresh process
 * with a fresh URL — a killed session's URL is gone for good, there is no
 * "cert appears later" path once the process is dead.
 */
import { readOriginCertState } from "./cloudflared-cert.ts";
import { loginArgs } from "./named-tunnel-args.ts";
import { ensureCloudflared } from "../cloudflared.service.ts";
import { killProcessTree } from "../windows-process-tree.ts";
import { broadcastGlobalEvent } from "../../server/ws/global.ts";
import { verifyCertLive, pinsMatch, renameCertAside, pumpLoginStream } from "./cloudflared-login-helpers.ts";

export type LoginState = "idle" | "waiting" | "slow" | "success" | "timeout" | "cancelled" | "error";
export interface LoginSnapshot { state: LoginState; url: string | null; message: string | null }

export const LOGIN_SLOW_MS = 60_000;
export const LOGIN_TIMEOUT_MS = 300_000;
const CERT_POLL_MS = 2_000;

interface Session {
  state: LoginState;
  url: string | null;
  message: string | null;
  proc: ReturnType<typeof Bun.spawn> | null;
  slowTimer: ReturnType<typeof setTimeout> | null;
  killTimer: ReturnType<typeof setTimeout> | null;
  certPollTimer: ReturnType<typeof setInterval> | null;
}

function freshSession(): Session {
  return { state: "idle", url: null, message: null, proc: null, slowTimer: null, killTimer: null, certPollTimer: null };
}

let session: Session = freshSession();

export function getLoginSnapshot(): LoginSnapshot {
  return { state: session.state, url: session.url, message: session.message };
}

function clearTimers(): void {
  if (session.slowTimer) clearTimeout(session.slowTimer);
  if (session.killTimer) clearTimeout(session.killTimer);
  if (session.certPollTimer) clearInterval(session.certPollTimer);
  session.slowTimer = null;
  session.killTimer = null;
  session.certPollTimer = null;
}

/** Move to a terminal state: clear timers, drop the process ref, broadcast. */
function setTerminal(state: LoginState, message: string | null): void {
  clearTimers();
  session.proc = null;
  session.state = state;
  session.message = message;
  broadcastGlobalEvent({ type: "tunnel:login_state", state, message: message ?? undefined });
}

/** Wraps `pumpLoginStream` with this module's session-singleton hooks. */
function pumpStream(stream: ReadableStream<Uint8Array>, proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  return pumpLoginStream(stream, {
    isSuperseded: () => session.proc !== proc,
    hasUrl: () => session.url != null,
    onUrl: (url) => {
      session.url = url;
      broadcastGlobalEvent({ type: "tunnel:login_url", url });
    },
    onSuccess: () => setTerminal("success", "logged in"),
  });
}

/**
 * Start (or return the live) login session.
 *
 * The cert-present shortcut is intentionally re-verified on every call — not
 * a bare `existsSync` — because a replaced or revoked cert must never
 * silently pass as "already logged in".
 */
export async function startLogin(opts: { relogin?: boolean } = {}): Promise<LoginSnapshot> {
  if (session.state === "waiting" || session.state === "slow") {
    return getLoginSnapshot();
  }

  const relogin = !!opts.relogin;
  if (!relogin) {
    const certState = readOriginCertState();
    if (certState.kind === "parsed") {
      const live = await verifyCertLive(certState.cert.apiToken);
      if (live && pinsMatch(certState.cert)) {
        session = freshSession();
        session.state = "success";
        session.message = "already logged in";
        return getLoginSnapshot();
      }
      // A dead token or an account/zone pin mismatch means this cert can
      // never pass the shortcut again as-is — move it aside now instead of
      // leaving a bad file to keep silently triggering the same fallthrough
      // on every future login attempt.
      renameCertAside();
    }
  } else {
    renameCertAside();
  }

  const bin = await ensureCloudflared();
  const proc = Bun.spawn([bin, ...loginArgs()], { stdout: "pipe", stderr: "pipe" });
  session = { state: "waiting", url: null, message: null, proc, slowTimer: null, killTimer: null, certPollTimer: null };

  session.slowTimer = setTimeout(() => {
    if (session.proc !== proc) return;
    session.state = "slow";
    broadcastGlobalEvent({ type: "tunnel:login_state", state: "slow" });
  }, LOGIN_SLOW_MS);

  session.killTimer = setTimeout(() => {
    if (session.proc !== proc) return;
    killProcessTree(proc.pid);
    setTerminal("timeout", "login timed out after 5 minutes");
  }, LOGIN_TIMEOUT_MS);

  session.certPollTimer = setInterval(() => {
    if (session.proc !== proc) return;
    if (readOriginCertState().kind === "parsed") setTerminal("success", "logged in");
  }, CERT_POLL_MS);

  Promise.all([pumpStream(proc.stdout, proc), pumpStream(proc.stderr, proc)])
    .then(async () => {
      if (session.proc !== proc) return; // already terminal
      const code = await proc.exited;
      if (session.proc !== proc) return;
      if (code === 0) {
        setTerminal("success", "logged in");
      } else {
        setTerminal("error", `cloudflared exited with code ${code}`);
      }
    })
    .catch(() => {});

  return getLoginSnapshot();
}

/** Kill the live process immediately (if any) and mark the session cancelled. */
export function cancelLogin(): void {
  if (session.proc) killProcessTree(session.proc.pid);
  setTerminal("cancelled", "cancelled");
}

// Orphaned login process on server crash/restart would otherwise wait forever
// for a browser callback that lands nowhere.
process.on("exit", () => {
  if (session.proc) {
    try { killProcessTree(session.proc.pid); } catch {}
  }
});

/**
 * Aggregate for callers that need a single patchable seam (the HTTP routes) —
 * route tests monkey-patch these properties directly rather than reaching for
 * `mock.module`, which replaces the module for every importer process-wide and
 * would poison the direct-function unit tests in this same file's test suite.
 */
export const cloudflaredLoginService = { getLoginSnapshot, startLogin, cancelLogin };
