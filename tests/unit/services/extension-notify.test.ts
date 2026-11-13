/**
 * `notify:send` as the main thread answers it: validation, the per-extension rate limit, and
 * the path it builds from `{ projectName, sessionId, providerId }` so the broadcast itself never
 * carries the real session id (`notification.service.ts:90-91` would let it collide with the
 * chat's own "done" push on that session).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { RpcChannel } from "../../../src/services/extension-rpc.ts";
import {
  extensionNotifyClock, notifyAnswerTimeout, registerExtensionNotifyHandlers, resetExtensionNotifyLimit,
  type ExtensionNotifyDeps,
} from "../../../src/services/extension-api/extension-notify-handlers.ts";
import { NotificationService, type BroadcastOptions, type NotificationPayload } from "../../../src/services/notification.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from "../../../src/shared/notification-settings.ts";
import { webPushService } from "../../../src/services/web-push/web-push.service.ts";
import { telegramService } from "../../../src/services/telegram-notification.service.ts";
import { ntfyService } from "../../../src/services/ntfy-notification.service.ts";
import { openTestDb, setDb, setSessionProvider } from "../../../src/services/db.service.ts";
import type { RpcMessage, RpcResponse } from "../../../src/types/extension.ts";
import { parseExtensionDeepLink } from "../../../src/shared/extension-deep-link.ts";

// This file reads and writes config, so it opens its own database rather than inheriting the
// process-wide one: an earlier file that ends with `closeDb()` leaves none, and `getDb()` would
// then reopen `ppm.db` under the test PPM_HOME, which other tests are free to overwrite.
setDb(openTestDb());

// Only the two tests that go through the real NotificationService touch these; patching the
// singletons (not mock.module, which leaks across test files) matches notification-dispatch.test.ts.
const originals = { push: webPushService.send, telegram: telegramService.send, ntfy: ntfyService.send, settings: configService.get("notifications") };
afterAll(() => {
  webPushService.send = originals.push;
  telegramService.send = originals.telegram;
  ntfyService.send = originals.ntfy;
  configService.set("notifications", originals.settings!);
});
let pushed: Array<{ path: string }> = [];
webPushService.send = (async (message: (typeof pushed)[number]) => { pushed.push(message); return { sent: 1, failed: 0, removed: 0 }; }) as unknown as typeof webPushService.send;
telegramService.send = (async () => {}) as typeof telegramService.send;
ntfyService.send = (async () => {}) as typeof ntfyService.send;

function settings(patch: Partial<NotificationSettings>): void {
  configService.set("notifications", { ...structuredClone(DEFAULT_NOTIFICATION_SETTINGS), ...patch });
}

function fakeDeps(overrides: Partial<ExtensionNotifyDeps> = {}) {
  const broadcasts: Array<{ type: string; payload: NotificationPayload; opts: BroadcastOptions }> = [];
  const deps: ExtensionNotifyDeps = {
    isKnownExtension: (id) => id === "fg",
    displayNameOf: (id) => (id === "fg" ? "Future Graph" : id),
    resolveSessionProvider: (sessionId) => (sessionId === "s1" ? { sessionId: "s1", providerId: "codex" } : null),
    projectExists: (name) => name === "ppm",
    linkTargetsOf: (id) => (id === "fg"
      ? { commands: ["fg.checkIn", "fg.panel", "fg.done"], deepLinkCommands: ["fg.checkIn", "fg.panel"] }
      : { commands: [], deepLinkCommands: [] }),
    broadcast: async (type, payload, opts) => {
      broadcasts.push({ type, payload, opts });
      return "sent";
    },
    ...overrides,
  };
  return { deps, broadcasts };
}

function channel(deps: ExtensionNotifyDeps) {
  const posted: RpcMessage[] = [];
  const rpc = new RpcChannel((msg) => posted.push(msg), { debug() {}, warn() {}, error() {} });
  registerExtensionNotifyHandlers(rpc, deps);
  let id = 0;
  const call = (params: unknown) => {
    const msgId = ++id;
    return rpc.handleMessage({ type: "request", id: msgId, method: "notify:send", params: [params] })
      .then(() => (posted.find((m) => m.type === "response" && m.id === msgId) as RpcResponse).result as any);
  };
  return { call };
}

const base = { extensionId: "fg", title: "Node merged", body: "Two nodes converged on the same outcome." };

describe("notify:send", () => {
  beforeEach(() => {
    resetExtensionNotifyLimit();
    settings({});
  });

  it("builds the chat link, blanks the payload's sessionId, prefixes the title and mints a coalesce key", async () => {
    const { deps, broadcasts } = fakeDeps();
    const { call } = channel(deps);
    expect(await call({ ...base, sessionId: "s1", projectName: "ppm" })).toEqual({ ok: true, result: "sent" });
    expect(broadcasts).toHaveLength(1);
    const [{ type, payload, opts }] = broadcasts;
    expect(type).toBe("extension");
    expect(payload).toMatchObject({
      title: "Future Graph: Node merged", body: base.body, project: "ppm", sessionId: "",
      providerId: "codex", path: "/project/ppm?openChat=codex%2Fs1",
    });
    expect(opts.coalesceKey).toMatch(/^ext:fg:/);
  });

  it("builds a bare project link with no session, and uses an explicit path as it is", async () => {
    const { deps, broadcasts } = fakeDeps();
    const { call } = channel(deps);
    await call({ ...base, projectName: "ppm" });
    expect(broadcasts[0]!.payload.path).toBe("/project/ppm");
    await call({ ...base, projectName: "ppm", path: "/project/ppm/design/landing" });
    expect(broadcasts[1]!.payload.path).toBe("/project/ppm/design/landing");
  });

  it("refuses a session and a path together: one destination per notification", async () => {
    const { deps, broadcasts } = fakeDeps();
    const { call } = channel(deps);
    expect((await call({ ...base, projectName: "ppm", sessionId: "s1", path: "/project/ppm/design/landing" })).error.code).toBe("BAD_REQUEST");
    expect(broadcasts).toHaveLength(0);
  });

  it("does not count a refused call against the hourly limit", async () => {
    const { deps } = fakeDeps();
    const { call } = channel(deps);
    const realNow = extensionNotifyClock.now;
    extensionNotifyClock.now = () => 2_000_000;
    try {
      for (let i = 0; i < 40; i++) expect((await call({ ...base, projectName: "no-such-project" })).error.code).toBe("BAD_REQUEST");
      for (let i = 0; i < 30; i++) expect((await call(base)).ok).toBe(true);
    } finally {
      extensionNotifyClock.now = realNow;
    }
  });

  it("links to the extension's own command, with its args and project, through the deep link", async () => {
    const { deps, broadcasts } = fakeDeps();
    const { call } = channel(deps);
    expect((await call({ ...base, projectName: "ppm", open: { command: "fg.checkIn", args: ["today", 2] } })).ok).toBe(true);
    const path = broadcasts[0]!.payload.path!;
    expect(path.startsWith("/project/ppm?extCommand=fg.checkIn&extArgs=")).toBe(true);
    expect(parseExtensionDeepLink(path)).toEqual({ kind: "command", command: "fg.checkIn", args: ["today", 2], projectName: "ppm" });
    expect(broadcasts[0]!.payload.sessionId).toBe("");
  });

  it("links to a panel by its view type, and works without a project", async () => {
    const { deps, broadcasts } = fakeDeps();
    const { call } = channel(deps);
    await call({ ...base, open: { view: "fg.panel" } });
    expect(broadcasts[0]!.payload.path).toBe("/?extView=fg.panel");
  });

  it("refuses a link to its own command that is not in contributes.deepLinkCommands (an action, not an opener)", async () => {
    const { deps, broadcasts } = fakeDeps();
    const { call } = channel(deps);
    const answer = await call({ ...base, projectName: "ppm", open: { command: "fg.done", args: ["item-1"] } });
    expect(answer.error.code).toBe("BAD_REQUEST");
    expect(answer.error.message).toContain("deepLinkCommands");
    // A linkable panel still opens by its view type.
    expect((await call({ ...base, open: { view: "fg.panel" } })).ok).toBe(true);
    expect(broadcasts.map((b) => b.payload.path)).toEqual(["/?extView=fg.panel"]);
  });

  it("refuses a view link to an unlisted command: the tab it opens would run that command", async () => {
    const { deps, broadcasts } = fakeDeps();
    const { call } = channel(deps);
    const answer = await call({ ...base, open: { view: "fg.done" } });
    expect(answer.error.code).toBe("BAD_REQUEST");
    expect(answer.error.message).toContain("open.view");
    expect(answer.error.message).toContain("deepLinkCommands");
    expect(broadcasts).toHaveLength(0);
  });

  it("refuses an open that names another extension's command, breaks the arg limits, or comes with sessionId or path", async () => {
    const { deps, broadcasts } = fakeDeps();
    const { call } = channel(deps);
    const cases: Record<string, unknown>[] = [
      { ...base, open: { command: "other.cmd" } },
      { ...base, open: { view: "not.declared" } },
      { ...base, open: { command: "fg.checkIn", view: "fg.panel" } },
      { ...base, open: {} },
      { ...base, open: "fg.checkIn" },
      { ...base, open: { command: "fg.checkIn", args: Array(9).fill(1) } },
      { ...base, open: { command: "fg.checkIn", args: [{ nested: true }] } },
      { ...base, open: { command: "fg.checkIn", args: ["x".repeat(1100)] } },
      { ...base, open: { view: "fg.panel", args: [1] } },
      { ...base, sessionId: "s1", open: { command: "fg.checkIn" } },
      { ...base, path: "/project/ppm", open: { command: "fg.checkIn" } },
    ];
    for (const request of cases) expect((await call(request)).error.code).toBe("BAD_REQUEST");
    expect(broadcasts).toHaveLength(0);
  });

  it("two separate calls each mint their own coalesce key", async () => {
    const { deps, broadcasts } = fakeDeps();
    const { call } = channel(deps);
    await call(base);
    await call(base);
    expect(broadcasts[0]!.opts.coalesceKey).not.toBe(broadcasts[1]!.opts.coalesceKey);
  });

  it("refuses an unknown extension, a bad title or body, a session or project that does not exist, and a path leaving the app", async () => {
    const { deps } = fakeDeps();
    const { call } = channel(deps);
    const cases: Record<string, unknown>[] = [
      { ...base, extensionId: "not-installed" },
      { ...base, title: "" },
      { ...base, title: "x".repeat(121) },
      { ...base, body: "x".repeat(1001) },
      { ...base, sessionId: "ghost" },
      { ...base, projectName: "no-such-project" },
      { ...base, path: "//evil.example.com" },
      { ...base, path: "/\\evil" },
    ];
    for (const request of cases) expect((await call(request)).error.code).toBe("BAD_REQUEST");
  });

  it("refuses the 31st call within an hour; a different extension has its own budget", async () => {
    const { deps } = fakeDeps();
    const { call } = channel(deps);
    const realNow = extensionNotifyClock.now;
    extensionNotifyClock.now = () => 1_000_000;
    try {
      for (let i = 0; i < 30; i++) expect((await call(base)).ok).toBe(true);
      expect(await call(base)).toEqual({
        ok: false, error: { code: "RATE_LIMITED", message: "At most 30 notifications an hour per extension" },
      });
      const other = fakeDeps({ isKnownExtension: (id) => id === "other", displayNameOf: () => "Other" });
      expect((await channel(other.deps).call({ ...base, extensionId: "other" })).ok).toBe(true);
    } finally {
      extensionNotifyClock.now = realNow;
    }
  });

  it("returns \"off\" without broadcasting when the extension event is switched off", async () => {
    settings({ events: { ...DEFAULT_NOTIFICATION_SETTINGS.events, extension: false } });
    const svc = new NotificationService(1);
    const { deps } = fakeDeps({ broadcast: (type, payload, opts) => svc.broadcast(type, payload, opts) });
    expect(await channel(deps).call(base)).toEqual({ ok: true, result: "off" });
  });

  it("answers \"queued\" at once when the real outcome is slower than the answer timeout, and still delivers it afterward", async () => {
    let resolveBroadcast!: (outcome: "sent") => void;
    const slow = new Promise<"sent">((resolve) => { resolveBroadcast = resolve; });
    const { deps, broadcasts } = fakeDeps({
      broadcast: async (type, payload, opts) => {
        broadcasts.push({ type, payload, opts });
        return slow;
      },
    });
    const originalMs = notifyAnswerTimeout.ms;
    notifyAnswerTimeout.ms = 10;
    try {
      const start = Date.now();
      const result = await channel(deps).call(base);
      const elapsed = Date.now() - start;
      expect(result).toEqual({ ok: true, result: "queued" });
      expect(elapsed).toBeLessThan(5_000); // nowhere near the real 60s delivery delay
      expect(broadcasts).toHaveLength(1); // the broadcast itself was still made, not skipped
      resolveBroadcast("sent"); // let the detached promise settle so it does not leak into other tests
      await Promise.resolve();
    } finally {
      notifyAnswerTimeout.ms = originalMs;
    }
  });

  it("still answers the real outcome when it beats the answer timeout, as every other test here assumes", async () => {
    const { deps } = fakeDeps(); // default fake resolves "sent" on the next microtask
    expect((await channel(deps).call(base))).toEqual({ ok: true, result: "sent" });
  });

  it("does not cancel, and is not cancelled by, the chat's own 'done' push for the same session", async () => {
    setDb(openTestDb());
    setSessionProvider("s1", "codex");
    settings({ delay_seconds: 20 });
    pushed = [];
    const svc = new NotificationService(1);
    const { deps } = fakeDeps({ broadcast: (type, payload, opts) => svc.broadcast(type, payload, opts) });
    const extOutcome = channel(deps).call({ ...base, sessionId: "s1" });
    const doneOutcome = svc.broadcast(
      "done", { title: "Chat completed", body: "x", project: "ppm", sessionId: "s1" }, { stillUnseen: () => true },
    );
    const [ext, done] = await Promise.all([extOutcome, doneOutcome]);
    expect(ext).toEqual({ ok: true, result: "sent" });
    expect(done).toBe("sent");
    expect(pushed).toHaveLength(2);
  });
});
