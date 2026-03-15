import { describe, it, expect } from "bun:test";
import { MockProvider } from "../../../src/providers/mock-provider.ts";

describe("MockProvider", () => {
  it("creates a session with UUID and metadata", async () => {
    const provider = new MockProvider();
    const session = await provider.createSession({
      projectName: "test-project",
      title: "Test Chat",
    });

    expect(session.id).toBeTruthy();
    expect(session.providerId).toBe("mock");
    expect(session.title).toBe("Test Chat");
    expect(session.projectName).toBe("test-project");
    expect(session.createdAt).toBeTruthy();
  });

  it("resumes an existing session", async () => {
    const provider = new MockProvider();
    const session = await provider.createSession({ title: "Original" });
    const resumed = await provider.resumeSession(session.id);

    expect(resumed.id).toBe(session.id);
    expect(resumed.title).toBe("Original");
  });

  it("throws on resume of non-existent session", async () => {
    const provider = new MockProvider();
    expect(provider.resumeSession("non-existent")).rejects.toThrow();
  });

  it("lists sessions", async () => {
    const provider = new MockProvider();
    await provider.createSession({ title: "Chat 1" });
    await provider.createSession({ title: "Chat 2" });
    const sessions = await provider.listSessions();

    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.title)).toContain("Chat 1");
    expect(sessions.map((s) => s.title)).toContain("Chat 2");
  });

  it("deletes a session", async () => {
    const provider = new MockProvider();
    const session = await provider.createSession({ title: "Doomed" });
    await provider.deleteSession(session.id);
    const sessions = await provider.listSessions();

    expect(sessions).toHaveLength(0);
  });

  it("streams text events for a simple message", async () => {
    const provider = new MockProvider();
    const session = await provider.createSession({});
    const events: any[] = [];

    for await (const event of provider.sendMessage(session.id, "hello")) {
      events.push(event);
    }

    const textEvents = events.filter((e) => e.type === "text");
    const doneEvents = events.filter((e) => e.type === "done");

    expect(textEvents.length).toBeGreaterThan(0);
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0].sessionId).toBe(session.id);
  });

  it("yields tool_use events for messages containing 'file'", async () => {
    const provider = new MockProvider();
    const session = await provider.createSession({});
    const events: any[] = [];

    for await (const event of provider.sendMessage(session.id, "read the file")) {
      events.push(event);
    }

    const toolUse = events.find((e) => e.type === "tool_use");
    const toolResult = events.find((e) => e.type === "tool_result");

    expect(toolUse).toBeTruthy();
    expect(toolUse.tool).toBe("Read");
    expect(toolResult).toBeTruthy();
    expect(toolResult.output).toContain("Main entry point");
  });

  it("yields approval_request for messages containing 'delete'", async () => {
    const provider = new MockProvider();
    const session = await provider.createSession({});
    const events: any[] = [];

    for await (const event of provider.sendMessage(session.id, "delete the temp files")) {
      events.push(event);
    }

    const approval = events.find((e) => e.type === "approval_request");
    expect(approval).toBeTruthy();
    expect(approval.tool).toBe("Bash");
    expect(approval.requestId).toBeTruthy();
  });

  it("updates session title from first message", async () => {
    const provider = new MockProvider();
    const session = await provider.createSession({});

    for await (const _ of provider.sendMessage(session.id, "My first question about testing")) {
      // consume
    }

    const sessions = await provider.listSessions();
    const updated = sessions.find((s) => s.id === session.id);
    expect(updated?.title).toContain("My first question");
  });

  it("stores message history", async () => {
    const provider = new MockProvider();
    const session = await provider.createSession({});

    for await (const _ of provider.sendMessage(session.id, "hello")) {
      // consume
    }

    const messages = provider.getMessages(session.id);
    expect(messages).toHaveLength(2); // user + assistant
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("hello");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBeTruthy();
  });

  it("yields error for non-existent session", async () => {
    const provider = new MockProvider();
    const events: any[] = [];

    for await (const event of provider.sendMessage("bad-id", "hello")) {
      events.push(event);
    }

    expect(events[0].type).toBe("error");
    expect(events[0].message).toBe("Session not found");
  });
});
