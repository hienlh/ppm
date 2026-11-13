/**
 * Antigravity Google OAuth PKCE login orchestration (`agy acp --login`).
 *
 * Spawns `agy acp --login` inside an isolated per-account home directory
 * (`HOME=<accountHome>`, `WSL_DISTRO_NAME=ppm`, `BROWSER=echo`, `DISPLAY=""`) so `agy`
 * prints the Google OAuth URL (`https://accounts.google.com/o/oauth2/auth?...`) and waits
 * on stdin for the authorization code or callback URL (`https://antigravity.google/oauth-callback?...`).
 *
 * Once the user submits the code/URL, `agy` exchanges it for an OAuth token and writes
 * `<accountHome>/.gemini/jetski-standalone-oauth-token`. We then query the account's
 * Language Server (`GetUserStatus` + `RetrieveUserQuotaSummary`) to populate its email,
 * display name, and plan tier (`Pro` / `Google AI Ultra` / etc.).
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  antigravityAccountHome,
  clearAntigravityAccountAuthFailure,
  createAntigravityAccount,
  DEFAULT_ANTIGRAVITY_ACCOUNT_ID,
  getAntigravityAccount,
  updateAntigravityAccountMeta,
  type AntigravityAccount,
} from "./antigravity-account.service.ts";
import {
  findAgyExecutable,
  stopManagedLanguageServer,
} from "../providers/antigravity/antigravity-connection.ts";
import { agyEnv } from "../providers/antigravity/acp-launch.ts";
import { fetchAntigravityAccountStatus, type AntigravityAccountInfo } from "../providers/antigravity/antigravity-usage.ts";
import { refreshUsage } from "./provider-usage/usage-registry.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("antigravity");

export type AntigravityLoginStatus =
  | { state: "pending" }
  | { state: "done"; account: AntigravityAccount }
  | { state: "error"; error: string };

export interface LoginProcessHandle {
  writeCode(codeOrUrl: string): void;
  waitForExit(): Promise<{ code: number | null; output: string }>;
  kill(): void;
}

export interface AntigravityLoginDeps {
  spawnLogin?: (home: string) => Promise<{ authUrl: string; handle: LoginProcessHandle }>;
  verifyHome?: (home: string) => Promise<AntigravityAccountInfo>;
}

interface PendingLogin {
  id: string;
  accountId: string;
  home: string;
  label?: string;
  reloginId?: string;
  authUrl: string;
  handle: LoginProcessHandle;
  verifyHome: (home: string) => Promise<AntigravityAccountInfo>;
  status: AntigravityLoginStatus;
  submitting: boolean;
  timer: ReturnType<typeof setTimeout>;
}

const pendingLogins = new Map<string, PendingLogin>();
const LOGIN_TTL_MS = 600_000;
const RESULT_GRACE_MS = 120_000;
const AUTH_URL_RE = /https:\/\/accounts\.google\.com\/o\/oauth2\/\S+/;

function unref(t: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  (t as { unref?: () => void }).unref?.();
  return t;
}

function defaultSpawnLogin(home: string): Promise<{ authUrl: string; handle: LoginProcessHandle }> {
  const agyBin = findAgyExecutable(home || undefined);
  if (!agyBin) {
    return Promise.reject(new Error("Antigravity CLI (agy) not found. Install Antigravity CLI first."));
  }

  return new Promise((resolve, reject) => {
    // agy's allowlist, not PPM's environment, which carries tokens (see acp-launch.ts). It
    // already holds PATH, DBUS_SESSION_BUS_ADDRESS and XDG_RUNTIME_DIR, all the sign-in needs to
    // reach the keyring; BROWSER and DISPLAY make agy print the URL instead of opening one.
    const env = { ...agyEnv(home || undefined, Boolean(home)), BROWSER: "echo", DISPLAY: "" };

    const proc = spawn(agyBin, ["acp", "--login"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let combinedOutput = "";
    let settledUrl = false;
    let exitResolver: ((res: { code: number | null; output: string }) => void) | null = null;
    const exitPromise = new Promise<{ code: number | null; output: string }>((r) => {
      exitResolver = r;
    });

    const handle: LoginProcessHandle = {
      writeCode(codeOrUrl: string) {
        try {
          proc.stdin?.write(`${codeOrUrl.trim()}\n`);
          proc.stdin?.end();
        } catch { /* ignore */ }
      },
      waitForExit() {
        return exitPromise;
      },
      kill() {
        try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      },
    };

    const startTimeout = unref(
      setTimeout(() => {
        if (!settledUrl) {
          settledUrl = true;
          handle.kill();
          reject(new Error("Timed out waiting for Google OAuth URL from agy acp --login."));
        }
      }, 10_000),
    );

    const onChunk = (chunk: Buffer | string) => {
      combinedOutput += chunk.toString();
      if (!settledUrl) {
        const match = AUTH_URL_RE.exec(combinedOutput);
        if (match?.[0]) {
          settledUrl = true;
          clearTimeout(startTimeout);
          resolve({ authUrl: match[0], handle });
        }
      }
    };

    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);
    proc.on("error", (err) => {
      clearTimeout(startTimeout);
      if (!settledUrl) {
        settledUrl = true;
        reject(err);
      }
      exitResolver?.({ code: 1, output: combinedOutput || err.message });
    });
    proc.on("close", (code) => {
      clearTimeout(startTimeout);
      if (!settledUrl) {
        settledUrl = true;
        const msg = combinedOutput.trim().slice(-240) || `agy acp --login exited with code ${code}`;
        reject(new Error(msg));
      }
      exitResolver?.({ code, output: combinedOutput });
    });
  });
}

function truncateLoginError(raw: string): string {
  const clean = raw.replace(/\s+/g, " ").trim();
  if (clean.length <= 240) return clean;
  return `${clean.slice(0, 237)}...`;
}

function settle(id: string, status: Exclude<AntigravityLoginStatus, { state: "pending" }>): void {
  const p = pendingLogins.get(id);
  if (!p || p.status.state !== "pending") return;
  p.status = status;
  clearTimeout(p.timer);
  p.handle.kill();
  if (status.state === "error" && !p.reloginId && p.home) {
    try { rmSync(p.home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  p.timer = unref(setTimeout(() => { pendingLogins.delete(id); }, RESULT_GRACE_MS));
}

/**
 * Start a Google OAuth PKCE login flow for a new or existing Antigravity account.
 * Returns `{ id, authUrl }` for the browser dialog.
 */
export async function startAntigravityLogin(
  label?: string,
  reloginAccountId?: string,
  deps: AntigravityLoginDeps = {},
): Promise<{ id: string; authUrl: string }> {
  if (reloginAccountId === DEFAULT_ANTIGRAVITY_ACCOUNT_ID) {
    throw new Error("Cannot sign in again on the default ambient account (~/.gemini). Sign in via Antigravity Desktop or add a new account.");
  }
  const target = reloginAccountId ? getAntigravityAccount(reloginAccountId) : null;
  if (reloginAccountId && !target) {
    throw new Error("Account not found");
  }
  if (target && !target.home) {
    throw new Error("Cannot sign in again on an ambient account without an isolated home directory.");
  }

  const id = randomUUID();
  const accountId = target ? target.id : id;
  const home = target ? target.home : antigravityAccountHome(accountId);
  if (home) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
  }

  const spawnFn = deps.spawnLogin ?? defaultSpawnLogin;
  const verifyFn = deps.verifyHome ?? ((h: string) => fetchAntigravityAccountStatus(h || undefined));

  try {
    const { authUrl, handle } = await spawnFn(home);
    const timer = unref(
      setTimeout(() => settle(id, { state: "error", error: "Login timed out" }), LOGIN_TTL_MS),
    );
    pendingLogins.set(id, {
      id,
      accountId,
      home,
      label: label?.trim() || undefined,
      reloginId: target?.id,
      authUrl,
      handle,
      verifyHome: verifyFn,
      status: { state: "pending" },
      submitting: false,
      timer,
    });
    log.info(`antigravity login flow=${id} started${target ? ` relogin=${target.id}` : ""}`);
    return { id, authUrl };
  } catch (e) {
    if (!target && home) {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    throw e;
  }
}

/**
 * Submit the Google authorization code or full callback URL pasted by the user.
 */
export async function submitAntigravityLoginCode(
  id: string,
  codeOrUrl: string,
): Promise<AntigravityLoginStatus> {
  const p = pendingLogins.get(id);
  if (!p) throw new Error("No pending Antigravity login found. Start a new login.");
  if (p.status.state !== "pending") return p.status;
  if (!codeOrUrl.trim()) throw new Error("Authorization code or callback URL is required.");
  if (p.submitting) return p.status;

  p.submitting = true;
  // Cancel the 10-minute expiry timer once submission begins so it cannot fire mid-exchange
  // and delete `p.home` right after the OAuth token file was written.
  clearTimeout(p.timer);
  p.handle.writeCode(codeOrUrl.trim());

  const exitResult = await Promise.race([
    p.handle.waitForExit(),
    new Promise<{ code: number | null; output: string }>((resolve) =>
      unref(setTimeout(() => resolve({ code: -1, output: "Timed out waiting for token exchange" }), 30_000)),
    ),
  ]);

  if (exitResult.code !== 0) {
    const rawMsg = exitResult.output.includes("Couldn't sign in")
      ? exitResult.output.split("Couldn't sign in:")[1]?.trim() || "Google OAuth code exchange failed."
      : exitResult.output.trim().slice(-240) || "Google OAuth code exchange failed.";
    settle(id, { state: "error", error: truncateLoginError(rawMsg) });
    return p.status;
  }

  if (p.home) {
    const tokenFile = join(p.home, ".gemini", "jetski-standalone-oauth-token");
    if (!existsSync(tokenFile)) {
      settle(id, { state: "error", error: "Login finished but no OAuth token was saved." });
      return p.status;
    }
    if (p.reloginId) {
      // Restart any running Language Server for this account so it picks up the new token.
      stopManagedLanguageServer(p.home);
    }
  }

  try {
    const info = await p.verifyHome(p.home).catch((): AntigravityAccountInfo => ({
      connected: true,
      usage: {},
    }));
    const resolvedLabel =
      p.label ||
      info.name ||
      info.email ||
      (p.reloginId ? getAntigravityAccount(p.reloginId)?.label : undefined) ||
      "Google Account";

    let account: AntigravityAccount;
    if (p.reloginId) {
      updateAntigravityAccountMeta(p.reloginId, {
        label: resolvedLabel,
        email: info.email ?? undefined,
        planType: info.planName ?? undefined,
      });
      account = getAntigravityAccount(p.reloginId)!;
    } else {
      account = createAntigravityAccount({
        id: p.accountId,
        label: resolvedLabel,
        email: info.email ?? null,
        planType: info.planName ?? null,
        home: p.home,
      });
    }
    clearAntigravityAccountAuthFailure(account.id);
    void refreshUsage("antigravity", account.id);
    settle(id, { state: "done", account });
    return p.status;
  } catch (e) {
    settle(id, { state: "error", error: truncateLoginError((e as Error).message) });
    return p.status;
  }
}

export function getAntigravityLoginStatus(id: string): AntigravityLoginStatus {
  return pendingLogins.get(id)?.status ?? { state: "error", error: "No pending login for that id" };
}

export function cancelAntigravityLogin(id: string): void {
  const p = pendingLogins.get(id);
  if (!p || p.submitting) return;
  pendingLogins.delete(id);
  clearTimeout(p.timer);
  p.handle.kill();
  if (p.status.state !== "done" && !p.reloginId && p.home) {
    try { rmSync(p.home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
