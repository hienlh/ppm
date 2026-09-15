import { describe, expect, it, spyOn } from "bun:test";
import { createServer } from "node:net";
import { buildCodexCallback, checkCodexLoginPort, parseBrowserLogin } from "../../../src/services/codex-login-callback.ts";
import { cancelBrowserLogin, getBrowserLoginStatus, startBrowserLogin, submitBrowserCallback, type LoginClient } from "../../../src/services/codex-account-login.ts";
import { getCodexAccount, removeCodexAccount } from "../../../src/services/codex-account.service.ts";

const redirect = "http://localhost:1455/auth/callback";
const authUrl = `https://auth.openai.com/oauth/authorize?state=session-state&redirect_uri=${encodeURIComponent(redirect)}`;
const callback = `${redirect}?code=one-use-code&state=session-state`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

class Client implements LoginClient {
  closed = false;
  notification: (n: { method: string; params?: unknown }) => void = () => {};
  start() {}
  onNotification(fn: typeof this.notification) { this.notification = fn; }
  onClose() {}
  notify() {}
  close() { this.closed = true; }
  async request<T>(method: string): Promise<T> {
    return (method === "account/login/start" ? { authUrl, loginId: "login-id", type: "chatgpt" }
      : method === "account/read" ? { account: { type: "chatgpt", email: "browser@example.com" } } : {}) as T;
  }
  complete(success: boolean) { this.notification({ method: "account/login/completed", params: { success } }); }
}

describe("Codex browser callback validation", () => {
  it("rebuilds a loopback request with only the code and state", () => {
    const target = buildCodexCallback(`${callback}&next=https://example.com`, parseBrowserLogin(authUrl));
    expect(target.origin).toBe("http://127.0.0.1:1455");
    expect([...target.searchParams.keys()]).toEqual(["code", "state"]);
  });

  it("rejects other hosts, ports, paths, credentials, fragments and ambiguous parameters", () => {
    for (const url of [
      callback.replace("localhost", "example.com"), callback.replace("1455", "8081"),
      callback.replace("/auth/callback", "/cancel"), callback.replace("localhost", "user@localhost"),
      `${callback}#fragment`, `${callback}&code=other`, `${callback}&state=other`,
      callback.replace("session-state", "other-session"), `${redirect}?state=session-state`,
      `${callback}&error=access_denied`, "not a URL",
    ]) expect(() => buildCodexCallback(url, parseBrowserLogin(authUrl))).toThrow();
  });

  it("rejects unsafe login metadata returned by the app-server", () => {
    for (const url of [authUrl.replace("auth.openai.com", "example.com"),
      authUrl.replace(encodeURIComponent(redirect), encodeURIComponent("http://localhost:8081/api")),
      "https://auth.openai.com/oauth/authorize"])
      expect(() => parseBrowserLogin(url)).toThrow();
  });

  it("preserves the exact supported onboarding state suffix", () => {
    expect(buildCodexCallback(`${callback}.onboarding_entrypoint=life_sciences`, parseBrowserLogin(authUrl)).searchParams.get("state"))
      .toBe("session-state.onboarding_entrypoint=life_sciences");
  });

  it("refuses an occupied login port without sending a cancellation request", async () => {
    let connections = 0;
    const server = createServer((socket) => { connections++; socket.destroy(); });
    await new Promise<void>((resolve) => server.listen(1455, "127.0.0.1", resolve));
    try {
      await expect(checkCodexLoginPort()).rejects.toThrow("busy");
      expect(connections).toBe(0);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});

describe("Codex browser login lifecycle", () => {
  it("preserves automatic authorization while account/read finishes past the login deadline", async () => {
    const originalTimeout = globalThis.setTimeout;
    const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: TimerHandler, delay?: number, ...args: unknown[]) =>
      originalTimeout(fn, delay === 600_000 ? 50 : delay, ...args)) as typeof setTimeout);
    const client = new Client();
    let release!: () => void;
    const readGate = new Promise<void>((resolve) => { release = resolve; });
    const request = client.request.bind(client);
    client.request = async <T,>(method: string): Promise<T> => {
      if (method === "account/read") await readGate;
      return request<T>(method);
    };
    let id: string | undefined;
    try {
      ({ id } = await startBrowserLogin("automatic", () => client));
      // No pasted callback: same-host browser completion uses the same lifecycle.
      client.complete(true);
      await new Promise((resolve) => originalTimeout(resolve, 80));
      expect(getBrowserLoginStatus(id).state).toBe("pending");
      expect(client.closed).toBe(false);
      release(); await tick();
      expect(getBrowserLoginStatus(id).state).toBe("done");
    } finally {
      release(); timerSpy.mockRestore();
      if (id) { removeCodexAccount(id); cancelBrowserLogin(id); }
    }
  });

  it("blocks concurrent browser starts, validates before forwarding, and sends a code once", async () => {
    const client = new Client();
    const { id } = await startBrowserLogin("browser", () => client);
    let calls = 0;
    const send = (async (url: URL, opts: RequestInit) => {
      calls++;
      expect(url.hostname).toBe("127.0.0.1");
      expect(opts.redirect).toBe("manual");
      return new Response("error page also uses 200");
    }) as typeof fetch;
    try {
      await expect(startBrowserLogin(undefined, () => new Client())).rejects.toThrow("already in progress");
      expect(() => submitBrowserCallback(id, callback.replace("session-state", "wrong"), send)).toThrow("different login");
      expect(calls).toBe(0);
      submitBrowserCallback(id, callback, send);
      submitBrowserCallback(id, callback, send);
      await tick();
      expect(calls).toBe(1);
      expect(getBrowserLoginStatus(id)).toEqual({ state: "pending" });
      expect(getCodexAccount(id)).toBeNull();
      client.complete(true);
      await tick();
      expect(getBrowserLoginStatus(id).state).toBe("done");
      expect(getCodexAccount(id)?.label).toBe("browser");
      submitBrowserCallback(id, callback, send);
      expect(calls).toBe(1);
    } finally { removeCodexAccount(id); cancelBrowserLogin(id); }
  });

  it("allows a retry after a transport failure and still finalizes by notification", async () => {
    const client = new Client();
    const { id } = await startBrowserLogin(undefined, () => client);
    let calls = 0;
    const send = (async () => { calls++; throw new Error("socket closed"); }) as unknown as typeof fetch;
    try {
      submitBrowserCallback(id, callback, send); await tick();
      expect(getBrowserLoginStatus(id).state).toBe("pending");
      submitBrowserCallback(id, callback, send); await tick();
      expect(calls).toBe(2);
      client.complete(true); await tick();
      expect(getBrowserLoginStatus(id).state).toBe("done");
    } finally { removeCodexAccount(id); cancelBrowserLogin(id); }
  });

  it("cancels forwarding and removes a pending flow", async () => {
    const client = new Client();
    const { id } = await startBrowserLogin(undefined, () => client);
    let signal: AbortSignal | null | undefined;
    const send = (async (_url: URL, opts: RequestInit) => {
      signal = opts.signal;
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }) as typeof fetch;
    submitBrowserCallback(id, callback, send);
    cancelBrowserLogin(id);
    await tick();
    expect(signal?.aborted).toBe(true);
    expect(client.closed).toBe(true);
    expect(getBrowserLoginStatus(id).state).toBe("error");
    expect(() => submitBrowserCallback(id, callback, send)).toThrow("No browser login");
  });
});
