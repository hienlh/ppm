/**
 * Codex account login orchestration. Logs codex into a per-account CODEX_HOME
 * via a short-lived app-server, verifies with account/read, then persists the
 * account. Supports API keys, device codes and browser OAuth callbacks.
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
import { buildCodexCallback, buildCodexSuccessCallback, checkCodexLoginPort, parseBrowserLogin, type BrowserLoginCallback } from "./codex-login-callback.ts";
import { CodexJsonRpcClient, CONTROL_REQUEST_TIMEOUT_MS } from "../providers/codex-app-server/codex-jsonrpc-client.ts";
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
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: unknown): void;
  close(): void;
}

async function handshake(c: LoginClient): Promise<void> {
  await c.request("initialize", { clientInfo: CLIENT_INFO, capabilities: CAPABILITIES }, CONTROL_REQUEST_TIMEOUT_MS);
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

interface ChatGptLogin {
  method: "device" | "browser";
  browser?: BrowserLoginCallback;
  callbackAbort?: AbortController;
  client: LoginClient; home: string; label?: string;
  status: DeviceLoginStatus;
  timer: ReturnType<typeof setTimeout>;
  /** True from the completion notification until the account is written. The
   * home must survive this window even if the browser walks away. */
  finalizing: boolean;
}
const pendingLogins = new Map<string, ChatGptLogin>();

type ChatGptLoginStart = { id: string; userCode: string; verificationUrl: string; authUrl: string };
type CompletionNotification = { success?: boolean; error?: string | null };

/** How long an unfinished authorization may sit before it is reaped. */
const DEVICE_LOGIN_TTL = 200_000;
const BROWSER_LOGIN_TTL = 600_000;
/** How long a finished result stays readable for the polling browser. */
const RESULT_GRACE_MS = 120_000;

function unref(t: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  (t as { unref?: () => void }).unref?.();
  return t;
}

function hasPendingBrowserLogin(): boolean {
  return [...pendingLogins.values()].some((p) => p.method === "browser" && p.status.state === "pending");
}

function isCurrentPendingLogin(id: string, p: ChatGptLogin): boolean {
  return pendingLogins.get(id) === p && p.status.state === "pending" && !p.finalizing;
}

/** Forget a flow entirely: stop its app-server, optionally drop its home. */
function disposeLogin(id: string, rmHome: boolean): void {
  const p = pendingLogins.get(id);
  if (!p) return;
  pendingLogins.delete(id);
  clearTimeout(p.timer);
  p.callbackAbort?.abort();
  try { p.client.close(); } catch { /* ignore */ }
  if (rmHome) { try { rmSync(p.home, { recursive: true, force: true }); } catch { /* ignore */ } }
}

/** Record the outcome and stop the app-server. First settle wins, so the close
 * event that trails a success cannot overwrite it. The entry lingers for
 * RESULT_GRACE_MS — that window is what makes a lost poll response harmless. */
function settle(id: string, status: Exclude<DeviceLoginStatus, { state: "pending" }>): void {
  const p = pendingLogins.get(id);
  if (!p || p.status.state !== "pending") return;
  p.status = status;
  clearTimeout(p.timer);
  p.callbackAbort?.abort();
  try { p.client.close(); } catch { /* ignore */ }
  // A failure leaves no account owning the dir, so the half-built home goes now.
  // A success must keep it: createCodexAccount adopted it as the account's home.
  if (status.state === "error") { try { rmSync(p.home, { recursive: true, force: true }); } catch { /* ignore */ } }
  p.timer = unref(setTimeout(() => { pendingLogins.delete(id); }, RESULT_GRACE_MS));
}

/** Turn the app-server's completion notification into a persisted account. */
async function finalizeLogin(id: string, notif: CompletionNotification): Promise<void> {
  const p = pendingLogins.get(id);
  if (!p || p.status.state !== "pending" || p.finalizing) return;
  if (!notif?.success) { settle(id, { state: "error", error: p.method === "browser" ? "ChatGPT sign-in failed. Start a new browser login and try again." : notif?.error || "login not completed" }); return; }
  p.finalizing = true;
  // Authorization has completed; account/read has its own bounded timeout.
  clearTimeout(p.timer);
  try {
    const read = await p.client.request<AccountRead>("account/read", {}, CONTROL_REQUEST_TIMEOUT_MS);
    if (!read?.account) throw new Error("login completed but account is empty");
    if (p.status.state !== "pending") return;
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
async function startChatGptLogin(
  method: "device" | "browser",
  label: string | undefined,
  makeClient: () => LoginClient,
): Promise<ChatGptLoginStart> {
  if (method === "browser" && hasPendingBrowserLogin()) {
    throw new Error("A browser login is already in progress. Finish or cancel it first.");
  }
  const id = randomUUID();
  const home = codexAccountHome(id);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const client = makeClient();
  client.onNotification((n) => {
    if (n.method === "account/login/completed") {
      void finalizeLogin(id, (n.params ?? {}) as CompletionNotification);
    }
  });
  client.onClose(() => settle(id, { state: "error", error: "login process exited" }));
  const timer = unref(setTimeout(() => settle(id, { state: "error", error: "timed out" }), method === "browser" ? BROWSER_LOGIN_TTL : DEVICE_LOGIN_TTL));
  const pending: ChatGptLogin = { method, client, home, label, status: { state: "pending" }, timer, finalizing: false };
  pendingLogins.set(id, pending);
  try {
    if (method === "browser") await checkCodexLoginPort();
    client.start({ codexHome: home });
    await handshake(client);
    const start = await client.request<{ userCode?: string; verificationUrl?: string; authUrl?: string }>(
      "account/login/start", { type: method === "browser" ? "chatgpt" : "chatgptDeviceCode" }, CONTROL_REQUEST_TIMEOUT_MS,
    );
    if (method === "browser") pending.browser = parseBrowserLogin(start.authUrl ?? "");
    return { id, userCode: start?.userCode ?? "", verificationUrl: start?.verificationUrl ?? "", authUrl: start?.authUrl ?? "" };
  } catch (e) {
    disposeLogin(id, true);
    throw e;
  }
}

export async function startDeviceLogin(label?: string, makeClient: () => LoginClient = () => new CodexJsonRpcClient()) {
  const { id, userCode, verificationUrl } = await startChatGptLogin("device", label, makeClient);
  return { id, userCode, verificationUrl };
}

export async function startBrowserLogin(label?: string, makeClient: () => LoginClient = () => new CodexJsonRpcClient()) {
  const { id, authUrl } = await startChatGptLogin("browser", label, makeClient);
  return { id, authUrl };
}

/** Submission is acknowledged immediately. Only the app-server notification and
 * account/read determine success, even if the forwarding HTTP request drops. */
export function submitBrowserCallback(id: string, callbackUrl: string, send: typeof fetch = fetch): void {
  const p = pendingLogins.get(id);
  if (!p || p.method !== "browser" || !p.browser) throw new Error("No browser login found. Start a new login.");
  if (p.status.state === "done" || p.finalizing) return;
  if (p.status.state === "error") throw new Error(p.status.error);
  const browser = p.browser;
  const target = buildCodexCallback(callbackUrl, browser);
  if (browser.submitted) return;
  browser.submitted = true;
  const controller = new AbortController();
  p.callbackAbort = controller;
  let timedOut = false;
  const timeout = unref(setTimeout(() => {
    timedOut = true;
    controller.abort();
    // Bun can leave a loopback fetch pending after its AbortSignal fires. Do not leave the
    // browser polling forever: the callback code cannot safely be reused, so make the
    // failure visible and let the user start a fresh authorization.
    if (isCurrentPendingLogin(id, p)) {
      settle(id, { state: "error", error: "Codex did not finish the callback within 30 seconds. Start a new browser login and try again." });
    }
  }, 30_000));
  void (async () => {
    try {
      // Connect to 127.0.0.1 (never a user-controlled localhost resolution), but preserve
      // the OAuth redirect's localhost Host header. Codex's loopback listener associates
      // the callback with the redirect URI and otherwise accepts the socket without
      // completing the login.
      let response = await send(target, {
        redirect: "manual",
        signal: controller.signal,
        headers: { Host: "localhost:1455" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("Codex returned a callback redirect without a destination.");
        response = await send(buildCodexSuccessCallback(location, browser), {
          redirect: "manual",
          signal: controller.signal,
          headers: { Host: "localhost:1455" },
        });
      }
      // Do not render or log either loopback OAuth response body.
      await response.body?.cancel();
      if (response.status >= 400 && isCurrentPendingLogin(id, p)) {
        settle(id, { state: "error", error: "Codex rejected the callback. Start a new browser login." });
      }
    } catch {
      // A closed callback socket may mean successful login. Polling owns the result.
      if (!timedOut && isCurrentPendingLogin(id, p)) browser.submitted = false;
    } finally {
      clearTimeout(timeout);
      if (p.callbackAbort === controller) p.callbackAbort = undefined;
    }
  })();
}

export function getBrowserLoginStatus(id: string): DeviceLoginStatus {
  const p = pendingLogins.get(id);
  return p?.method === "browser" ? p.status : { state: "error", error: "no pending browser login for that id" };
}

export function cancelBrowserLogin(id: string): void {
  if (pendingLogins.get(id)?.method === "browser") cancelDeviceLogin(id);
}

/** Read a device-code flow's outcome. Idempotent — repeat polls are free and a
 * dropped response costs one tick, not the flow. */
export function getDeviceLoginStatus(id: string): DeviceLoginStatus {
  return pendingLogins.get(id)?.status ?? { state: "error", error: "no pending device login for that id" };
}

/** Abandon a flow the user cancelled. A login already being written is left
 * alone — tearing it down here would delete the home mid-write and lose an
 * authorization the user completed. A finished one keeps its home: an account
 * owns it now. */
export function cancelDeviceLogin(id: string): void {
  const p = pendingLogins.get(id);
  if (!p || p.finalizing) return;
  disposeLogin(id, p.status.state !== "done");
}
