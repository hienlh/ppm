/**
 * Device-code login must survive losing the browser that started it. The flow
 * used to complete inside one long-lived HTTP request, so a dropped socket
 * destroyed the result even though the account had been created. These drive
 * the state machine through a fake app-server client.
 */
import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import {
  startDeviceLogin, getDeviceLoginStatus, cancelDeviceLogin, type LoginClient,
} from "../../../src/services/codex-account-login.ts";
import { getCodexAccount, removeCodexAccount } from "../../../src/services/codex-account.service.ts";

/** Stands in for `codex app-server`: canned responses, manual notifications. */
class FakeClient implements LoginClient {
  notif: (n: { method: string; params?: unknown }) => void = () => {};
  onCloseFn: (code: number | null) => void = () => {};
  closed = false;
  accountRead: unknown = { account: { type: "chatgpt", email: "user@example.com", planType: "plus" } };
  readError: string | null = null;

  start(): void {}
  onNotification(fn: (n: { method: string; params?: unknown }) => void): void { this.notif = fn; }
  onClose(fn: (code: number | null) => void): void { this.onCloseFn = fn; }
  notify(): void {}
  close(): void { this.closed = true; }

  async request<T>(method: string): Promise<T> {
    if (method === "account/read") {
      if (this.readError) throw new Error(this.readError);
      return this.accountRead as T;
    }
    if (method === "account/login/start") {
      return { userCode: "ABCD-1234", verificationUrl: "https://example.com/device" } as T;
    }
    return {} as T;
  }

  /** Deliver the app-server's completion notification. */
  complete(params: { success?: boolean; error?: string | null }): void {
    this.notif({ method: "account/login/completed", params });
  }
}

/** The notification handler finalizes asynchronously; let its microtasks drain. */
const settled = () => new Promise((r) => setTimeout(r, 5));

describe("codex device-code login (poll-based)", () => {
  it("completes without the starting request: status flips to done and stays readable", async () => {
    const fake = new FakeClient();
    const { id, userCode, verificationUrl } = await startDeviceLogin("work", () => fake);
    expect(userCode).toBe("ABCD-1234");
    expect(verificationUrl).toBe("https://example.com/device");
    expect(getDeviceLoginStatus(id)).toEqual({ state: "pending" });

    fake.complete({ success: true });
    await settled();

    const s = getDeviceLoginStatus(id);
    expect(s.state).toBe("done");
    if (s.state !== "done") throw new Error("unreachable");
    expect(s.account.id).toBe(id);
    expect(s.account.type).toBe("chatgpt");
    expect(s.account.label).toBe("work");

    // The account is persisted, and re-polling is idempotent — this is what a
    // browser that lost its response relies on.
    expect(getCodexAccount(id)?.label).toBe("work");
    expect(getDeviceLoginStatus(id)).toEqual(s);
    expect(existsSync(s.account.home)).toBe(true);
    expect(fake.closed).toBe(true);

    removeCodexAccount(id);
  });

  it("falls back to the account email when no label was given", async () => {
    const fake = new FakeClient();
    const { id } = await startDeviceLogin(undefined, () => fake);
    fake.complete({ success: true });
    await settled();
    expect(getCodexAccount(id)?.label).toBe("user@example.com");
    removeCodexAccount(id);
  });

  it("reports a rejected authorization and drops the half-built home", async () => {
    const fake = new FakeClient();
    const { id } = await startDeviceLogin("nope", () => fake);
    fake.complete({ success: false, error: "user denied" });
    await settled();
    expect(getDeviceLoginStatus(id)).toEqual({ state: "error", error: "user denied" });
    expect(getCodexAccount(id)).toBeNull();
    cancelDeviceLogin(id);
  });

  it("reports the app-server dying mid-authorization", async () => {
    const fake = new FakeClient();
    const { id } = await startDeviceLogin(undefined, () => fake);
    fake.onCloseFn(1);
    await settled();
    expect(getDeviceLoginStatus(id)).toEqual({ state: "error", error: "login process exited" });
    cancelDeviceLogin(id);
  });

  it("keeps the first outcome when the process exits right after succeeding", async () => {
    const fake = new FakeClient();
    const { id } = await startDeviceLogin(undefined, () => fake);
    fake.complete({ success: true });
    await settled();
    fake.onCloseFn(0);
    await settled();
    expect(getDeviceLoginStatus(id).state).toBe("done");
    removeCodexAccount(id);
  });

  it("surfaces an account/read failure instead of persisting a blank account", async () => {
    const fake = new FakeClient();
    fake.readError = "account/read blew up";
    const { id } = await startDeviceLogin(undefined, () => fake);
    fake.complete({ success: true });
    await settled();
    expect(getDeviceLoginStatus(id)).toEqual({ state: "error", error: "account/read blew up" });
    expect(getCodexAccount(id)).toBeNull();
    cancelDeviceLogin(id);
  });

  it("cancel during finalize cannot destroy an authorization already granted", async () => {
    const fake = new FakeClient();
    let releaseRead!: () => void;
    const readGate = new Promise<void>((r) => { releaseRead = r; });
    const read = fake.request.bind(fake);
    fake.request = (async <T,>(method: string): Promise<T> => {
      if (method === "account/read") await readGate;
      return read<T>(method);
    }) as typeof fake.request;

    const { id } = await startDeviceLogin("slow", () => fake);
    fake.complete({ success: true });
    await settled(); // finalize is now parked inside account/read

    cancelDeviceLogin(id); // browser walks away mid-write
    releaseRead();
    await settled();

    expect(getDeviceLoginStatus(id).state).toBe("done");
    expect(getCodexAccount(id)?.label).toBe("slow");
    removeCodexAccount(id);
  });

  it("reports an unknown id rather than throwing", () => {
    expect(getDeviceLoginStatus("not-a-flow")).toEqual({
      state: "error", error: "no pending device login for that id",
    });
  });

  it("cancel releases the app-server and forgets the flow", async () => {
    const fake = new FakeClient();
    const { id } = await startDeviceLogin(undefined, () => fake);
    cancelDeviceLogin(id);
    expect(fake.closed).toBe(true);
    expect(getDeviceLoginStatus(id).state).toBe("error");
  });
});
