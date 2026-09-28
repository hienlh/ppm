import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { getDb, setSessionDesignSlug, setSessionMetadata } from "../../../src/services/db.service.ts";
import { createDesign } from "../../../src/services/design/design-store.service.ts";
import { listSnapshots } from "../../../src/services/design/design-snapshots.service.ts";
import {
  flushTurnSnapshots, pendingTurnSnapshotCount, scheduleTurnSnapshot, setTurnSnapshotDebounceForTests,
} from "../../../src/services/design/design-turn-snapshot.ts";
import type { AIProvider, ChatEvent } from "../../../src/types/chat.ts";

function stubProvider(id: string, events: ChatEvent[]): AIProvider {
  return {
    id, name: id, supportsSharedContext: true, supportsDesignInstructions: true,
    async createSession() { return { id: "x", providerId: id, title: "", createdAt: "" }; },
    async resumeSession() { return { id: "x", providerId: id, title: "", createdAt: "" }; },
    async listSessions() { return []; },
    async deleteSession() {},
    async *sendMessage() {
      for (const event of events) yield event;
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("turn snapshots", () => {
  let project: string;

  beforeAll(() => setTurnSnapshotDebounceForTests(40));
  afterAll(() => setTurnSnapshotDebounceForTests(null));
  beforeEach(async () => {
    getDb().run("DELETE FROM session_metadata");
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-turn-")));
    await createDesign(project, { title: "Home", kind: "page" });
  });
  afterEach(async () => {
    await flushTurnSnapshots();
    rmSync(project, { recursive: true, force: true });
  });

  it("debounces a burst of turn ends into one snapshot of the final state", async () => {
    setSessionDesignSlug("d1", "home");
    scheduleTurnSnapshot("d1", project);
    writeFileSync(join(project, "designs", "home", "index.html"), "later");
    scheduleTurnSnapshot("d1", project);
    expect(pendingTurnSnapshotCount()).toBe(1);
    await sleep(120);
    await flushTurnSnapshots();
    const history = await listSnapshots(project, "home");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ reason: "turn", sessionId: "d1" });
  });

  it("ignores an ordinary session", async () => {
    scheduleTurnSnapshot("plain", project);
    expect(pendingTurnSnapshotCount()).toBe(0);
    await flushTurnSnapshots();
    expect(await listSnapshots(project, "home")).toEqual([]);
  });

  it("falls back to the project path stored for the session", async () => {
    setSessionDesignSlug("d2", "home");
    setSessionMetadata("d2", "proj", project);
    scheduleTurnSnapshot("d2");
    await flushTurnSnapshots();
    expect(await listSnapshots(project, "home")).toHaveLength(1);
  });

  it("is snapshotted from a direct sendMessage, as the CLI and scheduler call it, on done and on a finished background task", async () => {
    providerRegistry.register(stubProvider("stub-turn-snap", [
      { type: "text", content: "working" },
      { type: "done", sessionId: "d3" },
    ]));
    setSessionDesignSlug("d3", "home");
    setSessionMetadata("d3", "proj", project);
    for await (const _ of chatService.sendMessage("stub-turn-snap", "d3", "make it blue")) { /* consume */ }
    expect(pendingTurnSnapshotCount()).toBe(1);
    await flushTurnSnapshots();
    expect(await listSnapshots(project, "home")).toHaveLength(1);

    // A task that is still running is not a reason to snapshot.
    providerRegistry.register(stubProvider("stub-turn-running", [
      { type: "system", subtype: "task_notification", taskStatus: "running" } as ChatEvent,
      { type: "system", subtype: "task_started" } as ChatEvent,
    ]));
    for await (const _ of chatService.sendMessage("stub-turn-running", "d3", "")) { /* consume */ }
    expect(pendingTurnSnapshotCount()).toBe(0);

    // The agent's background work lands after the turn ended; its completion snapshots again.
    writeFileSync(join(project, "designs", "home", "index.html"), "written by a background task");
    providerRegistry.register(stubProvider("stub-turn-bg", [
      { type: "system", subtype: "task_notification", taskStatus: "running" } as ChatEvent,
      { type: "system", subtype: "task_notification", taskStatus: "completed" } as ChatEvent,
    ]));
    for await (const _ of chatService.sendMessage("stub-turn-bg", "d3", "")) { /* consume */ }
    expect(pendingTurnSnapshotCount()).toBe(1);
    await flushTurnSnapshots();
    expect(await listSnapshots(project, "home")).toHaveLength(2);
  });

  it("folds a done followed by the turn's background task finishing into one snapshot", async () => {
    providerRegistry.register(stubProvider("stub-turn-both", [
      { type: "done", sessionId: "d4" },
      { type: "system", subtype: "task_notification", taskStatus: "completed" } as ChatEvent,
    ]));
    setSessionDesignSlug("d4", "home");
    setSessionMetadata("d4", "proj", project);
    for await (const _ of chatService.sendMessage("stub-turn-both", "d4", "go")) { /* consume */ }
    await flushTurnSnapshots();
    const history = await listSnapshots(project, "home");
    expect(history).toHaveLength(1);
    expect(history[0]!.sessionId).toBe("d4");
  });

  it("leaves a non-design session's stream untouched", async () => {
    const events: ChatEvent[] = [{ type: "text", content: "hi" }, { type: "done", sessionId: "plain2" }];
    providerRegistry.register(stubProvider("stub-turn-plain", events));
    const seen: ChatEvent[] = [];
    for await (const event of chatService.sendMessage("stub-turn-plain", "plain2", "hi")) seen.push(event);
    expect(seen).toEqual(events);
    expect(pendingTurnSnapshotCount()).toBe(0);
  });
});
