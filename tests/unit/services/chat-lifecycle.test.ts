/**
 * The bus server-side listeners hear a chat on, and the switch that holds a chat's push
 * notifications back. Neither may ever break the chat it observes: a listener or suppressor that
 * throws is logged and skipped.
 */
import { afterEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { createChatLifecycle } from "../../../src/services/chat-control/chat-lifecycle.ts";
import { addNotificationSuppressor, isNotificationSuppressed } from "../../../src/services/chat-control/notification-suppressor.ts";

describe("chat lifecycle bus", () => {
  it("delivers each event to every listener of that event only", () => {
    const bus = createChatLifecycle();
    const heard: string[] = [];
    bus.on("stream", (p) => heard.push(`a:${p.sessionId}`));
    bus.on("stream", (p) => heard.push(`b:${p.sessionId}`));
    bus.on("migrated", (p) => heard.push(`m:${p.newSessionId}`));
    bus.emit("stream", { sessionId: "s1", event: { type: "text" } });
    expect(heard).toEqual(["a:s1", "b:s1"]);
    bus.emit("migrated", { oldSessionId: "s1", newSessionId: "s2" });
    expect(heard).toEqual(["a:s1", "b:s1", "m:s2"]);
  });

  it("stops delivering once a listener unsubscribes", () => {
    const bus = createChatLifecycle();
    let count = 0;
    const off = bus.on("turn_ended", () => { count++; });
    const ended = { sessionId: "s", outcome: "done" as const, projectName: "p", providerId: "mock" };
    bus.emit("turn_ended", ended);
    off();
    bus.emit("turn_ended", ended);
    expect(count).toBe(1);
    expect(bus.has("turn_ended")).toBe(false);
  });

  it("keeps a throwing listener from reaching the emitter or the listeners after it", () => {
    const bus = createChatLifecycle();
    const heard: string[] = [];
    bus.on("user_message", () => { throw new Error("listener bug"); });
    bus.on("user_message", (p) => heard.push(p.text));
    const message = { sessionId: "s", text: "hi", origin: "telegram" as const, imageCount: 0, projectName: "p", providerId: "mock" };
    expect(() => bus.emit("user_message", message)).not.toThrow();
    expect(() => bus.emit("user_message", { ...message, text: "again" })).not.toThrow();
    expect(heard).toEqual(["hi", "again"]);
  });

  it("lets a listener unsubscribe itself mid-emit without skipping the others", () => {
    const bus = createChatLifecycle();
    const heard: string[] = [];
    const off = bus.on("approval_resolved", () => { heard.push("once"); off(); });
    bus.on("approval_resolved", () => heard.push("always"));
    const resolved = { sessionId: "s", requestId: "r", approved: true, reason: "answered" };
    bus.emit("approval_resolved", resolved);
    bus.emit("approval_resolved", resolved);
    expect(heard).toEqual(["once", "always", "always"]);
  });

  it("does nothing when nobody listens", () => {
    const bus = createChatLifecycle();
    expect(bus.has("stream")).toBe(false);
    expect(() => bus.emit("stream", { sessionId: "s", event: {} })).not.toThrow();
  });
});

describe("notification suppressors", () => {
  const removals: Array<() => void> = [];
  afterEach(() => { for (const remove of removals.splice(0)) remove(); });
  const add = (fn: Parameters<typeof addNotificationSuppressor>[0]) => removals.push(addNotificationSuppressor(fn));

  it("hold nothing back when none is registered", () => {
    expect(isNotificationSuppressed("s", "done")).toBe(false);
  });

  it("are asked per session and kind, and any one of them holds a notification back", () => {
    add((sessionId, kind) => sessionId === "bound" && kind === "done");
    add((sessionId, kind) => sessionId === "watched" && kind === "approval");
    expect(isNotificationSuppressed("bound", "done")).toBe(true);
    expect(isNotificationSuppressed("bound", "approval")).toBe(false);
    expect(isNotificationSuppressed("watched", "approval")).toBe(true);
    expect(isNotificationSuppressed("other", "done")).toBe(false);
  });

  it("stop being asked once removed", () => {
    const remove = addNotificationSuppressor(() => true);
    expect(isNotificationSuppressed("s", "done")).toBe(true);
    remove();
    expect(isNotificationSuppressed("s", "done")).toBe(false);
  });

  it("let a throwing one claim nothing while the others are still asked", () => {
    add(() => { throw new Error("bridge down"); });
    expect(isNotificationSuppressed("s", "approval")).toBe(false);
    add((sessionId) => sessionId === "s");
    expect(isNotificationSuppressed("s", "approval")).toBe(true);
  });
});
