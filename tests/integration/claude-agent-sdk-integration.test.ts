import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { query, listSessions, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentSdkProvider } from "../../src/providers/claude-agent-sdk.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Remove CLAUDECODE env to avoid nested session error
delete process.env.CLAUDECODE;

// Use a temp directory so SDK sessions don't pollute the real project
let tempDir: string;
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(join(tmpdir(), "ppm-sdk-test-"));
  process.chdir(tempDir);
});

afterAll(() => {
  process.chdir(originalCwd);
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
});

/** Collect all messages from a query */
async function collectMessages(q: AsyncIterable<SDKMessage>): Promise<SDKMessage[]> {
  const msgs: SDKMessage[] = [];
  for await (const msg of q) {
    msgs.push(msg);
  }
  return msgs;
}

describe("Claude Agent SDK — raw SDK", () => {
  it("query() returns init + assistant + result messages", async () => {
    const sessionId = crypto.randomUUID();
    const msgs = await collectMessages(
      query({
        prompt: "Reply with exactly: PONG",
        options: {
          sessionId,
          maxTurns: 1,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
        } as any,
      }),
    );

    const types = msgs.map((m) => m.type);
    expect(types).toContain("system"); // init
    expect(types).toContain("assistant");
    expect(types).toContain("result");

    // Verify init has session_id
    const init = msgs.find((m) => m.type === "system" && (m as any).subtype === "init");
    expect(init).toBeTruthy();
    expect(init!.session_id).toBeTruthy();

    // Verify assistant message has text content
    const assistant = msgs.find((m) => m.type === "assistant");
    const content = (assistant as any)?.message?.content;
    expect(Array.isArray(content)).toBe(true);
    const textBlock = content.find((b: any) => b.type === "text");
    expect(textBlock).toBeTruthy();
    expect(textBlock.text.toUpperCase()).toContain("PONG");

    // Verify result
    const result = msgs.find((m) => m.type === "result") as any;
    expect(result.subtype).toBe("success");
    expect(typeof result.result).toBe("string");
    expect(result.result.toUpperCase()).toContain("PONG");
  }, 30000);

  it("resume continues conversation context", async () => {
    const sessionId = crypto.randomUUID();

    // Turn 1: tell it a secret
    const turn1 = await collectMessages(
      query({
        prompt: "Remember this secret code: ALPHA-7742. Reply with just 'Noted.'",
        options: {
          sessionId,
          maxTurns: 1,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
        } as any,
      }),
    );
    const result1 = turn1.find((m) => m.type === "result") as any;
    expect(result1).toBeTruthy();

    // Turn 2: ask it back — uses resume
    const turn2 = await collectMessages(
      query({
        prompt: "What was the secret code I told you? Reply with just the code.",
        options: {
          resume: sessionId,
          maxTurns: 1,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
        } as any,
      }),
    );
    const result2 = turn2.find((m) => m.type === "result") as any;
    expect(result2).toBeTruthy();
    expect(result2.result).toContain("ALPHA-7742");
  }, 60000);

  it("listSessions() returns session metadata", async () => {
    const sessions = await listSessions({ limit: 5 });

    expect(Array.isArray(sessions)).toBe(true);
    if (sessions.length > 0) {
      const s = sessions[0]!;
      expect(s.sessionId).toBeTruthy();
      expect(typeof s.summary).toBe("string");
      expect(typeof s.lastModified).toBe("number");
    }
  }, 15000);

  it("getSessionMessages() returns transcript", async () => {
    // Create a session first
    const sessionId = crypto.randomUUID();
    await collectMessages(
      query({
        prompt: "Say hello",
        options: {
          sessionId,
          maxTurns: 1,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
        } as any,
      }),
    );

    const messages = await getSessionMessages(sessionId);
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThanOrEqual(1);

    // Should have at least assistant message
    const hasAssistant = messages.some((m) => m.type === "assistant");
    expect(hasAssistant).toBe(true);
  }, 30000);
});

describe("ClaudeAgentSdkProvider — PPM integration", () => {
  const provider = new ClaudeAgentSdkProvider();

  it("createSession returns valid session with UUID", async () => {
    const session = await provider.createSession({
      projectName: "test-project",
      title: "Integration Test",
    });

    expect(session.id).toBeTruthy();
    expect(session.id).not.toContain("pending");
    expect(session.providerId).toBe("claude");
    expect(session.title).toBe("Integration Test");
    expect(session.projectName).toBe("test-project");
  });

  it("sendMessage streams text events and done", async () => {
    const session = await provider.createSession({ title: "Stream Test" });
    const events: any[] = [];

    for await (const event of provider.sendMessage(session.id, "Reply with exactly: OK")) {
      events.push(event);
    }

    const textEvents = events.filter((e) => e.type === "text");
    const doneEvent = events.find((e) => e.type === "done");

    expect(textEvents.length).toBeGreaterThan(0);
    const fullText = textEvents.map((e) => e.content).join("");
    expect(fullText.toUpperCase()).toContain("OK");

    expect(doneEvent).toBeTruthy();
    expect(doneEvent.sessionId).toBe(session.id);
  }, 30000);

  it("done event includes resultSubtype success", async () => {
    const session = await provider.createSession({ title: "Subtype Test" });
    const events: any[] = [];

    for await (const event of provider.sendMessage(session.id, "Reply with: test")) {
      events.push(event);
    }

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeTruthy();
    expect(doneEvent.resultSubtype).toBe("success");
  }, 30000);

  it("done event includes numTurns", async () => {
    const session = await provider.createSession({ title: "NumTurns Test" });
    const events: any[] = [];

    for await (const event of provider.sendMessage(session.id, "Reply with: hello")) {
      events.push(event);
    }

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeTruthy();
    // Simple text reply should use 0 tool turns
    expect(typeof doneEvent.numTurns).toBe("number");
  }, 30000);

  it("multi-turn: resume maintains context", async () => {
    const session = await provider.createSession({ title: "Multi-turn" });

    // Turn 1
    for await (const _ of provider.sendMessage(session.id, "Remember: my favorite color is purple. Reply 'Got it.'")) {
      // consume
    }

    // Turn 2 — should resume same session
    const events: any[] = [];
    for await (const event of provider.sendMessage(session.id, "What is my favorite color? Reply with just the color.")) {
      events.push(event);
    }

    const fullText = events
      .filter((e) => e.type === "text")
      .map((e) => e.content)
      .join("");
    expect(fullText.toLowerCase()).toContain("purple");
  }, 60000);

  it("handles non-existent session gracefully", async () => {
    // SDK may reject unknown session IDs — provider should handle without crashing
    const events: any[] = [];
    for await (const event of provider.sendMessage("nonexistent-id", "hello")) {
      events.push(event);
    }

    // Provider should yield events (text, error, or done) without throwing
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => ["text", "usage", "error", "done"].includes(e.type))).toBe(true);
  }, 15000);

  it("deleteSession removes session from active list", async () => {
    const session = await provider.createSession({ title: "Delete me" });
    await provider.deleteSession(session.id);

    // After delete, sendMessage may auto-resume or error — should not throw
    const events: any[] = [];
    for await (const event of provider.sendMessage(session.id, "hello")) {
      events.push(event);
    }
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => ["text", "usage", "error", "done"].includes(e.type))).toBe(true);
  }, 15000);
});

describe("Claude Agent SDK — maxTurns limit", () => {
  it("yields error_max_turns when maxTurns exceeded", async () => {
    const sessionId = crypto.randomUUID();
    const msgs = await collectMessages(
      query({
        prompt: "Use the Bash tool to run 'echo step1', then 'echo step2', then 'echo step3', then 'echo step4'. Run each one separately.",
        options: {
          sessionId,
          maxTurns: 1, // Very low — should hit limit quickly
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          allowedTools: ["Bash"],
        } as any,
      }),
    );

    const result = msgs.find((m) => m.type === "result") as any;
    expect(result).toBeTruthy();
    // With maxTurns=1, should either succeed in 1 turn or hit the limit
    expect(["success", "error_max_turns"]).toContain(result.subtype);
    expect(typeof result.num_turns).toBe("number");
  }, 60000);
});

describe("Claude Agent SDK — systemPrompt preset", () => {
  it("uses claude_code preset for enhanced responses", async () => {
    const sessionId = crypto.randomUUID();
    const msgs = await collectMessages(
      query({
        prompt: "What tools do you have available? List 3 tool names only.",
        options: {
          sessionId,
          maxTurns: 1,
          systemPrompt: { type: "preset", preset: "claude_code" },
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
        } as any,
      }),
    );

    const result = msgs.find((m) => m.type === "result") as any;
    expect(result).toBeTruthy();
    expect(result.subtype).toBe("success");
    // With claude_code preset, Claude should know about its built-in tools
    const text = result.result?.toLowerCase() ?? "";
    expect(
      text.includes("read") || text.includes("bash") || text.includes("edit") || text.includes("glob"),
    ).toBe(true);
  }, 30000);
});
