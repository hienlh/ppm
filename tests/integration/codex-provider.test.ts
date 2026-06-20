import { describe, it, expect } from "bun:test";
import { CodexAppServerProvider } from "../../src/providers/codex-app-server/codex-provider.ts";

describe("CodexAppServerProvider skeleton", () => {
  const p = new CodexAppServerProvider();

  it("exposes id/name", () => {
    expect(p.id).toBe("codex");
    expect(p.name).toBe("Codex");
  });

  it("implements the required + optional AIProvider methods", () => {
    for (const m of [
      "createSession", "resumeSession", "listSessions", "deleteSession", "sendMessage",
      "pushMessage", "abortQuery", "hasStreamingSession", "getMessages",
      "listSessionsByDir", "isAvailable", "listModels", "resolveApproval",
    ]) {
      expect(typeof (p as any)[m]).toBe("function");
    }
    expect(typeof (p as any).cleanupAll).toBe("function");
  });

  it("creates and resumes an in-memory session", async () => {
    const s = await p.createSession({ title: "T", projectName: "proj" });
    expect(s.providerId).toBe("codex");
    const r = await p.resumeSession(s.id);
    expect(r.id).toBe(s.id);
  });

  it("isAvailable resolves to a boolean", async () => {
    const v = await p.isAvailable();
    expect(typeof v).toBe("boolean");
  }, 20_000);

  it("hasStreamingSession is false for unknown session", () => {
    expect(p.hasStreamingSession("nope")).toBe(false);
  });

  it("resolveApproval / abortQuery no-op safely with no live session", () => {
    expect(() => p.resolveApproval("missing", true)).not.toThrow();
    expect(() => p.abortQuery("missing")).not.toThrow();
  });

  it("listSessionsByDir fail-closed for an unrelated dir → []", async () => {
    expect(await p.listSessionsByDir("/definitely/not/a/codex/project")).toEqual([]);
  });
});

// Gated live test — requires `@openai/codex` installed + `codex login`.
// Opt in with CODEX_LIVE_TEST=1 (avoids hangs/downloads in CI).
const LIVE = process.env.CODEX_LIVE_TEST === "1";
describe.skipIf(!LIVE)("CodexAppServerProvider live (gated)", () => {
  it("streams two sequential turns then aborts", async () => {
    const p = new CodexAppServerProvider();
    const s = await p.createSession({ title: "live", projectPath: process.cwd() });
    let sawText = false;
    let dones = 0;
    const it = p.sendMessage(s.id, "Say hi in one word.", { permissionMode: "bypassPermissions" })[Symbol.asyncIterator]();
    const deadline = Date.now() + 60_000;
    let pushed = false;
    while (Date.now() < deadline) {
      const { value, done } = await it.next();
      if (done) break;
      if (value.type === "text") sawText = true;
      if (value.type === "done") {
        dones++;
        if (!pushed) { pushed = true; p.pushMessage((value as any).sessionId, "And again, one word."); }
        else break;
      }
    }
    p.cleanupAll();
    expect(sawText).toBe(true);
    expect(dones).toBeGreaterThanOrEqual(2);
  }, 70_000);
});
