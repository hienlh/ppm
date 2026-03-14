import { describe, it, expect } from "bun:test";
import { query, listSessions, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentSdkProvider } from "../../src/providers/claude-agent-sdk.ts";

// Remove CLAUDECODE env to avoid nested session error
delete process.env.CLAUDECODE;

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
      projectName: "ppm",
      title: "Integration Test",
    });

    expect(session.id).toBeTruthy();
    expect(session.id).not.toContain("pending");
    expect(session.providerId).toBe("claude-sdk");
    expect(session.title).toBe("Integration Test");
    expect(session.projectName).toBe("ppm");
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

  it("stores message history after sendMessage", async () => {
    const session = await provider.createSession({});
    for await (const _ of provider.sendMessage(session.id, "Hello provider")) {
      // consume
    }

    const messages = provider.getMessages(session.id);
    expect(messages.length).toBe(2); // user + assistant
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Hello provider");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content.length).toBeGreaterThan(0);
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

  it("updates title from first message", async () => {
    const session = await provider.createSession({});
    for await (const _ of provider.sendMessage(session.id, "How do I write tests in Bun?")) {
      // consume
    }

    const sessions = await provider.listSessions();
    const updated = sessions.find((s) => s.id === session.id);
    // In-memory sessions should have updated title
    const meta = (provider as any).sessions.get(session.id);
    expect(meta.title).toContain("How do I write tests");
  }, 30000);

  it("returns error for non-existent session", async () => {
    const events: any[] = [];
    for await (const event of provider.sendMessage("nonexistent-id", "hello")) {
      events.push(event);
    }

    expect(events[0].type).toBe("error");
    expect(events[0].message).toContain("Session not found");
  });

  it("deleteSession removes session", async () => {
    const session = await provider.createSession({ title: "Delete me" });
    await provider.deleteSession(session.id);

    const events: any[] = [];
    for await (const event of provider.sendMessage(session.id, "hello")) {
      events.push(event);
    }
    expect(events[0].type).toBe("error");
  });
});
