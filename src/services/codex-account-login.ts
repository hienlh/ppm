/**
 * Codex account login orchestration. Logs codex into a per-account CODEX_HOME
 * via a short-lived app-server, verifies with account/read, then persists the
 * account. Two headless paths:
 *   - apiKey: instant (account/login/start stores the key; validated on first use).
 *   - chatgptDeviceCode: returns a user-code + URL; the app-server's
 *     account/login/completed notification finalizes the account in the
 *     background and the browser short-polls getDeviceLoginStatus for it.
 *
 * Device-code completion deliberately does NOT ride on the HTTP request that
 * started it. Holding one request open for the whole authorization means any
 * dropped socket (a proxy or tunnel in front of PPM) destroys the only path the
 * result had — the login still succeeds server-side but the browser is told it
 * failed, and a retry cannot recover the flow.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { CodexJsonRpcClient } from "../providers/codex-app-server/codex-jsonrpc-client.ts";
import { codexAccountHome, createCodexAccount, type CodexAccount } from "./codex-account.service.ts";

const CLIENT_INFO = { name: "ppm", title: "PPM", version: "0.0.0" };
const CAPABILITIES = { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: null };

interface AccountRead { account: { type: string; email?: string; planType?: string | null } | null }

/** The slice of the app-server client the login flow uses. Narrowing it here lets
 * a unit test drive the whole flow without spawning a real subprocess. */
export interface LoginClient {
  start(opts?: { cwd?: string; codexHome?: string }): void;
  onNotification(fn: (n: { method: string; params?: unknown }) => void): void;
  onClose(fn: (code: number | null) => void): void;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  close(): void;
}

async function handshake(c: LoginClient): Promise<void> {
  await c.request("initialize", { clientInfo: CLIENT_INFO, capabilities: CAPABILITIES });
  c.notify("initialized");
}

/** Add an apiKey account (headless, instant). Cleans up the home on failure. */
export async function addApiKeyAccount(apiKey: string, label?: string): Promise<CodexAccount> {
  const id = randomUUID();
  const home = codexAccountHome(id);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const client = new CodexJsonRpcClient();
  try {
    client.start({ codexHome: home });
    await handshake(client);
    await client.request("account/login/start", { type: "apiKey", apiKey });
    const read = await client.request<AccountRead>("account/read", {});
    if (!read?.account) throw new Error("apiKey login did not authenticate");
    return createCodexAccount({
      id, label: label || "API key", type: "apiKey",
      planType: read.account.planType ?? null, creds: { type: "apiKey", apiKey },
    });
  } catch (e) {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
    throw e;
  } finally {
    client.close();
  }
}

// ── ChatGPT device-code login ──

/** Terminal states stay readable for a grace window, so a poll that loses its
 * response can simply ask again instead of losing the outcome. */
export type DeviceLoginStatus =
  | { state: "pending" }
  | { state: "done"; account: CodexAccount }
  | { state: "error"; error: string };

interface DeviceLogin {
  client: LoginClient; home: string; label?: string;
  status: DeviceLoginStatus;
  timer: ReturnType<typeof setTimeout>;
  /** True from the completion notification until the account is written. The
   * home must survive this window even if the browser walks away. */
  finalizing: boolean;
}
const deviceLogins = new Map<string, DeviceLogin>();

/** How long an unfinished authorization may sit before it is reaped. */
const DEVICE_LOGIN_TTL = 200_000;
/** How long a finished result stays readable for the polling browser. */
const RESULT_GRACE_MS = 120_000;

function unref(t: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  (t as { unref?: () => void }).unref?.();
  return t;
}

/** Forget a flow entirely: stop its app-server, optionally drop its home. */
function disposeDeviceLogin(id: string, rmHome: boolean): void {
  const p = deviceLogins.get(id);
  if (!p) return;
  deviceLogins.delete(id);
  clearTimeout(p.timer);
  try { p.client.close(); } catch { /* ignore */ }
  if (rmHome) { try { rmSync(p.home, { recursive: true, force: true }); } catch { /* ignore */ } }
}

/** Record the outcome and stop the app-server. First settle wins, so the close
 * event that trails a success cannot overwrite it. The entry lingers for
 * RESULT_GRACE_MS — that window is what makes a lost poll response harmless. */
function settle(id: string, status: Exclude<DeviceLoginStatus, { state: "pending" }>): void {
  const p = deviceLogins.get(id);
  if (!p || p.status.state !== "pending") return;
  p.status = status;
  clearTimeout(p.timer);
  try { p.client.close(); } catch { /* ignore */ }
  // A failure leaves no account owning the dir, so the half-built home goes now.
  // A success must keep it: createCodexAccount adopted it as the account's home.
  if (status.state === "error") { try { rmSync(p.home, { recursive: true, force: true }); } catch { /* ignore */ } }
  p.timer = unref(setTimeout(() => { deviceLogins.delete(id); }, RESULT_GRACE_MS));
}

/** Turn the app-server's completion notification into a persisted account. */
async function finalizeDeviceLogin(id: string, notif: { success?: boolean; error?: string | null }): Promise<void> {
  const p = deviceLogins.get(id);
  if (!p || p.status.state !== "pending") return;
  if (!notif?.success) { settle(id, { state: "error", error: notif?.error || "login not completed" }); return; }
  p.finalizing = true;
  try {
    const read = await p.client.request<AccountRead>("account/read", {});
    if (!read?.account) throw new Error("login completed but account is empty");
    const account = createCodexAccount({
      id, label: p.label || read.account.email || "ChatGPT", type: "chatgpt",
      planType: read.account.planType ?? null,
    });
    settle(id, { state: "done", account });
  } catch (e) {
    settle(id, { state: "error", error: (e as Error).message });
  }
}

/** Begin a ChatGPT device-code login. Returns the code/URL the user enters in a
 * browser; the caller then polls getDeviceLoginStatus. */
export async function startDeviceLogin(
  label?: string,
  makeClient: () => LoginClient = () => new CodexJsonRpcClient(),
): Promise<{ id: string; userCode: string; verificationUrl: string }> {
  const id = randomUUID();
  const home = codexAccountHome(id);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const client = makeClient();
  client.onNotification((n) => {
    if (n.method === "account/login/completed") {
      void finalizeDeviceLogin(id, (n.params ?? {}) as { success?: boolean; error?: string | null });
    }
  });
  client.onClose(() => settle(id, { state: "error", error: "login process exited" }));
  // Never cleared by a poll: an abandoned browser cannot leak the subprocess or
  // the half-built home the way a request-scoped timer could.
  const timer = unref(setTimeout(() => settle(id, { state: "error", error: "timed out" }), DEVICE_LOGIN_TTL));
  // Registered before the first I/O so a notification (or an immediate exit)
  // arriving mid-handshake still finds its entry.
  deviceLogins.set(id, { client, home, label, status: { state: "pending" }, timer, finalizing: false });
  try {
    client.start({ codexHome: home });
    await handshake(client);
    const start = await client.request<{ userCode?: string; verificationUrl?: string }>(
      "account/login/start", { type: "chatgptDeviceCode" },
    );
    return { id, userCode: start?.userCode ?? "", verificationUrl: start?.verificationUrl ?? "" };
  } catch (e) {
    disposeDeviceLogin(id, true);
    throw e;
  }
}

/** Read a device-code flow's outcome. Idempotent — repeat polls are free and a
 * dropped response costs one tick, not the flow. */
export function getDeviceLoginStatus(id: string): DeviceLoginStatus {
  return deviceLogins.get(id)?.status ?? { state: "error", error: "no pending device login for that id" };
}

/** Abandon a flow the user cancelled. A login already being written is left
 * alone — tearing it down here would delete the home mid-write and lose an
 * authorization the user completed. A finished one keeps its home: an account
 * owns it now. */
export function cancelDeviceLogin(id: string): void {
  const p = deviceLogins.get(id);
  if (!p || p.finalizing) return;
  disposeDeviceLogin(id, p.status.state !== "done");
}
