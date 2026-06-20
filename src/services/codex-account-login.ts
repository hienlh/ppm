/**
 * Codex account login orchestration (P2). Logs codex into a per-account
 * CODEX_HOME via a short-lived app-server, verifies with account/read, then
 * persists the account. Two headless paths (P0-verified):
 *   - apiKey: instant (account/login/start stores the key; validated on first use).
 *   - chatgptDeviceCode: returns a user-code + URL; completes via the
 *     account/login/completed notification (long-poll via awaitDeviceLogin).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { CodexJsonRpcClient } from "../providers/codex-app-server/codex-jsonrpc-client.ts";
import { codexAccountHome, createCodexAccount, type CodexAccount } from "./codex-account.service.ts";

const CLIENT_INFO = { name: "ppm", title: "PPM", version: "0.0.0" };
const CAPABILITIES = { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: null };

interface AccountRead { account: { type: string; email?: string; planType?: string | null } | null }

async function handshake(c: CodexJsonRpcClient): Promise<void> {
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

interface PendingLogin {
  client: CodexJsonRpcClient; home: string; label?: string;
  completed: Promise<{ success?: boolean; error?: string | null }>;
  timer: ReturnType<typeof setTimeout>;
}
const pendingDeviceLogins = new Map<string, PendingLogin>();
const DEVICE_LOGIN_TTL = 200_000; // self-cleanup window if the client never calls /await

/** Drop a pending login: close its subprocess, optionally remove its (half-built) home. */
function purgePending(id: string, rmHome: boolean): void {
  const p = pendingDeviceLogins.get(id);
  if (!p) return;
  pendingDeviceLogins.delete(id);
  clearTimeout(p.timer);
  try { p.client.close(); } catch { /* ignore */ }
  if (rmHome) { try { rmSync(p.home, { recursive: true, force: true }); } catch { /* ignore */ } }
}

/** Begin a ChatGPT device-code login. Returns the code/URL the user enters in a browser. */
export async function startDeviceLogin(label?: string): Promise<{ id: string; userCode: string; verificationUrl: string }> {
  const id = randomUUID();
  const home = codexAccountHome(id);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const client = new CodexJsonRpcClient();
  let resolveDone!: (v: { success?: boolean; error?: string | null }) => void;
  const completed = new Promise<{ success?: boolean; error?: string | null }>((r) => { resolveDone = r; });
  client.onNotification((n) => {
    if (n.method === "account/login/completed") resolveDone((n.params ?? {}) as { success?: boolean; error?: string | null });
  });
  client.onClose(() => resolveDone({ success: false, error: "login process exited" }));
  // Self-cleanup if the FE abandons the flow (never calls /await): reap the orphan
  // subprocess + half-built home. Cleared once /await claims the pending entry.
  const timer = setTimeout(() => purgePending(id, true), DEVICE_LOGIN_TTL);
  (timer as { unref?: () => void }).unref?.();
  try {
    client.start({ codexHome: home });
    await handshake(client);
    const start = await client.request<{ userCode?: string; verificationUrl?: string }>("account/login/start", { type: "chatgptDeviceCode" });
    pendingDeviceLogins.set(id, { client, home, label, completed, timer });
    return { id, userCode: start?.userCode ?? "", verificationUrl: start?.verificationUrl ?? "" };
  } catch (e) {
    clearTimeout(timer);
    try { client.close(); } catch { /* ignore */ }
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
    throw e;
  }
}

/** Long-poll until the device login completes (or times out). Persists on success. */
export async function awaitDeviceLogin(id: string, timeoutMs = 180_000): Promise<CodexAccount> {
  const p = pendingDeviceLogins.get(id);
  if (!p) throw new Error("no pending device login for that id");
  // Claim-once: remove from the map + cancel self-cleanup so a double-await or the
  // timer can't race this call.
  pendingDeviceLogins.delete(id);
  clearTimeout(p.timer);
  const timeout = new Promise<{ success?: boolean; error?: string | null }>((r) => setTimeout(() => r({ success: false, error: "timed out" }), timeoutMs));
  try {
    const res = await Promise.race([p.completed, timeout]);
    if (!res?.success) throw new Error(res?.error || "login not completed");
    const read = await p.client.request<AccountRead>("account/read", {});
    if (!read?.account) throw new Error("login completed but account is empty");
    // Success: keep the home (it now holds auth.json) — createCodexAccount reuses it.
    return createCodexAccount({
      id, label: p.label || read.account.email || "ChatGPT", type: "chatgpt", planType: read.account.planType ?? null,
    });
  } catch (e) {
    try { rmSync(p.home, { recursive: true, force: true }); } catch { /* ignore */ }
    throw e;
  } finally {
    try { p.client.close(); } catch { /* ignore */ }
  }
}
