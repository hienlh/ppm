import { afterAll, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeIndex } from "../../../../src/services/file-index/index-walk.ts";
import { gatherVoiceContext, type VoiceContextDeps } from "../../../../src/services/voice-message/voice-context.ts";
import {
  contextLineOf, fileNamesFromIndexJson, instructionsDigest,
} from "../../../../src/services/voice-message/voice-context-sources.ts";
import { encodeVoicePart } from "../../../../src/shared/voice-message.ts";
import type { ChatMessage } from "../../../../src/types/chat.ts";

const root = mkdtempSync(join(tmpdir(), "ppm-voice-ctx-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const msg = (m: Partial<ChatMessage>): ChatMessage => ({ id: "m", role: "user", content: "", timestamp: "", ...m });

describe("contextLineOf", () => {
  it("reads a user prompt, and a voice message by its typed text and transcript", () => {
    expect(contextLineOf(msg({ content: "chạy lại   bun test" }))).toBe("User: chạy lại bun test");
    const voice = `ảnh đây\n${encodeVoicePart({ path: "/a.wav", durationSec: 3, transcript: "sửa file router" })}`;
    expect(contextLineOf(msg({ content: voice }))).toBe("User: ảnh đây sửa file router");
  });

  it("keeps the assistant's prose and leaves tool calls and results out", () => {
    const line = contextLineOf(msg({
      role: "assistant",
      content: "",
      events: [
        { type: "text", content: "Đã sửa " },
        { type: "tool_use", tool: "Bash", input: { command: "cat secret.txt" }, toolUseId: "t1" },
        { type: "tool_result", output: "SECRET OUTPUT", toolUseId: "t1" },
        { type: "text", content: "xong." },
      ] as unknown as ChatMessage["events"],
    }));
    expect(line).toBe("Assistant: Đã sửa xong.");
  });

  it("cuts a long message and skips synthetic and system ones", () => {
    expect(contextLineOf(msg({ content: "x".repeat(1000) }))!.length).toBeLessThanOrEqual("User: ".length + 400);
    expect(contextLineOf(msg({ content: "compacted", synthetic: true }))).toBeNull();
    expect(contextLineOf(msg({ role: "system", content: "hi" }))).toBeNull();
  });
});

describe("instructionsDigest", () => {
  it("keeps headings and backticked terms once, never fenced code or prose", () => {
    const md = "# Project\nSome prose about `getPpmDir()` and `Hono`.\n## Commands\n```bash\n# not a heading `nope`\n```\nUse `hono` again.\n";
    expect(instructionsDigest(md)).toBe("Headings: Project; Commands\nTerms: getPpmDir(), Hono");
  });

  it("stays under its cap", () => {
    const md = Array.from({ length: 2000 }, (_, i) => `## Heading number ${i}\nterm \`identifier${i}\``).join("\n");
    expect(instructionsDigest(md).length).toBeLessThanOrEqual(3000);
  });
});

describe("fileNamesFromIndexJson", () => {
  it("lists file names once, skipping folders and git-ignored files", () => {
    const { json } = serializeIndex([
      { path: "src", name: "src", type: "directory" },
      { path: "src/index.ts", name: "index.ts", type: "file" },
      { path: "web/index.ts", name: "index.ts", type: "file" },
      { path: ".env", name: ".env", type: "file", isIgnored: true },
      { path: "a\"b.ts", name: "a\"b.ts", type: "file" },
    ]);
    expect(fileNamesFromIndexJson(json)).toEqual(["index.ts", "a\"b.ts"]);
  });
});

describe("gatherVoiceContext", () => {
  const project = join(root, "proj");
  const claudeHome = join(root, "claude");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "CLAUDE.md"), "# PPM\nUse `Bun.spawn`.\n");
  const slug = realpathSync(project).normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
  mkdirSync(join(claudeHome, "projects", slug, "memory"), { recursive: true });
  writeFileSync(join(claudeHome, "projects", slug, "memory", "MEMORY.md"), "- [No WSL](x.md)\n");

  const calls: string[] = [];
  const deps: VoiceContextDeps = {
    recentMessages: async (ref) => { calls.push(`${ref.providerId}:${ref.sessionId}:${ref.projectPath}`); return ["User: hi"]; },
    fileIndexJson: async () => serializeIndex([{ path: "router.ts", name: "router.ts", type: "file" }]).json,
    claudeHome: () => claudeHome,
    notebookTexts: () => ["Thăng reviews PRs in Vietnamese"],
  };

  it("collects every source for a project, reading the session under that project", async () => {
    const ctx = await gatherVoiceContext({ project: "p", projectPath: project, sessionId: "s1", providerId: "claude", typed: "  typed ", words: ["Hono"] }, deps);
    expect(ctx).toEqual({
      recentMessages: ["User: hi"], typed: "typed", instructions: "Headings: PPM\nTerms: Bun.spawn", memory: "- [No WSL](x.md)",
      fileNames: ["router.ts"], words: ["Hono"],
    });
    expect(calls).toEqual([`claude:s1:${project}`]);
  });

  it("reads no session for an unknown provider, and a failing read leaves its part empty", async () => {
    calls.length = 0;
    const ctx = await gatherVoiceContext({ project: "p", projectPath: join(root, "missing"), sessionId: "s1", providerId: "cursor", words: [] }, {
      ...deps, fileIndexJson: async () => { throw new Error("cold"); },
    });
    expect(calls).toEqual([]);
    expect(ctx).toMatchObject({ recentMessages: [], instructions: "", memory: "", fileNames: [] });
    const failing = await gatherVoiceContext({ project: "p", projectPath: project, sessionId: "s1", providerId: "codex", words: [] }, {
      ...deps, recentMessages: async () => { throw new Error("not in this project"); },
    });
    expect(failing.recentMessages).toEqual([]);
  });

  it("gives the Assistant its notebook and the project names, and no files", async () => {
    let indexAsked = false;
    const ctx = await gatherVoiceContext({ project: "__assistant__", projectPath: project, words: ["ppm"] }, {
      ...deps, fileIndexJson: async () => { indexAsked = true; return null; },
    });
    expect(indexAsked).toBe(false);
    expect(ctx).toMatchObject({ instructions: "", memory: "", fileNames: [], notebook: "Thăng reviews PRs in Vietnamese", words: ["ppm"] });
    expect(Array.isArray(ctx.projectNames)).toBe(true);
  });
});
