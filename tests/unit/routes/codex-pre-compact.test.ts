import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import { chatRoutes } from "../../../src/server/routes/chat.ts";
import { isCodexRolloutPath, getCodexPreCompactMessages } from "../../../src/providers/codex-app-server/codex-history.ts";

test("managed Codex Windows transcript loads pre-compact history through the correct route", async () => {
  const root = join(getPpmDir(), "codex-accounts");
  mkdirSync(root, { recursive: true });
  const account = mkdtempSync(join(root, "compact-test-"));
  try {
    const sessions = join(account, "sessions");
    mkdirSync(sessions);
    const file = join(sessions, "rollout.jsonl");
    writeFileSync(file, [
      { type: "session_meta", payload: { id: "test", cwd: process.cwd() } },
      { type: "event_msg", payload: { type: "user_message", message: "Before compaction" } },
      { type: "compacted", payload: { message: "Summary", replacement_history: [] } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    expect(isCodexRolloutPath(file)).toBe(true);
    expect(isCodexRolloutPath(file.replace(/\\/g, "/"))).toBe(true);
    expect(isCodexRolloutPath(join(account, "sessions-evil", "rollout.jsonl"))).toBe(false);
    expect(isCodexRolloutPath(join(account, "sessions", "..", "private.jsonl"))).toBe(false);
    if (process.platform !== "win32") {
      expect(isCodexRolloutPath(join(getPpmDir(), "codex-accounts\\fake\\sessions\\private.jsonl"))).toBe(false);
    }
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("projectPath" as never, process.cwd() as never); await next(); });
    app.route("/chat", chatRoutes);
    const response = await app.request(`/chat/pre-compact-messages?jsonlPath=${encodeURIComponent(file)}`);
    expect(response.status).toBe(200);
    expect((await response.json() as any).data.some((m: any) => m.content === "Before compaction")).toBe(true);
  } finally { rmSync(account, { recursive: true, force: true }); }
});

test("a directory link inside managed sessions cannot escape the transcript roots", () => {
  const root = join(getPpmDir(), "codex-accounts");
  mkdirSync(root, { recursive: true });
  const account = mkdtempSync(join(root, "compact-link-test-"));
  const outside = mkdtempSync(join(getPpmDir(), "outside-transcripts-"));
  const link = join(account, "sessions", "linked");
  try {
    mkdirSync(join(account, "sessions"));
    writeFileSync(join(outside, "private.jsonl"), "{}\n");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    expect(() => getCodexPreCompactMessages(join(link, "private.jsonl"), process.cwd())).toThrow(/Access denied/);
  } finally {
    try { unlinkSync(link); } catch { /* Link was not created. */ }
    rmSync(account, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
