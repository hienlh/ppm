/**
 * The Assistant's watch tools: they never ask, they only ever point at a chat of a registered
 * project, and none of them runs in a turn a watch started. `chat_start` can watch the chat it
 * opens, set before the first message goes and dropped if that message never does.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configService } from "../../../src/services/config.service.ts";
import { getDb, setSessionAssistant } from "../../../src/services/db.service.ts";
import { _setClaudeProjectsRoot } from "../../../src/services/agent-transcript/claude-projects-root.ts";
import { listAssistantWatches } from "../../../src/services/assistant-hub/assistant-hub-db.ts";
import { createChatLifecycle } from "../../../src/services/chat-control/chat-lifecycle.ts";
import { AssistantWatchService } from "../../../src/services/assistant-watch/assistant-watch.service.ts";
import {
  chatListWatchesTool, chatStartWatcher, chatUnwatchTool, chatWatchTool,
} from "../../../src/services/assistant-mcp/assistant-watch-tools.ts";
import { chatStart } from "../../../src/services/assistant-mcp/assistant-hub-tools.ts";
import type { AssistantChatDelivery } from "../../../src/services/assistant-mcp/assistant-chat-send.ts";

const text = (r: Record<string, unknown>) => (r.content as Array<{ text: string }>)[0]!.text;
const isError = (r: Record<string, unknown>) => r.isError === true;

const ASSISTANT = "asst-tools";
const SESSION = "6c1e4b7a-2f3d-4a5b-8c9d-0e1f2a3b4c5d";
let root: string;
let savedProjects: unknown;
let service: AssistantWatchService;
const notWatchTurn = () => false;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-watch-tools-"));
  const project = join(root, "api");
  mkdirSync(project, { recursive: true });
  const claudeRoot = join(root, "claude-projects");
  const dir = join(claudeRoot, project.replace(/[/\\:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SESSION}.jsonl`), '{"type":"user"}\n');
  _setClaudeProjectsRoot(claudeRoot);
  savedProjects = configService.get("projects");
  configService.set("projects", [{ name: "api", path: project }]);
});
afterAll(() => {
  _setClaudeProjectsRoot(null);
  configService.set("projects", savedProjects as never);
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  getDb().run("DELETE FROM assistant_watches");
  service = new AssistantWatchService({
    control: () => null, lifecycle: createChatLifecycle(), addSuppressor: () => () => {}, turnEndSince: () => null, notify: () => {},
  });
  service.start();
});
afterEach(() => service.stop());

describe("chat_watch", () => {
  it("watches a project's chat without asking, and lists and stops it", () => {
    const result = chatWatchTool(ASSISTANT, { project: "api", sessionId: SESSION, notifyOn: ["done"] }, { service, watchTurn: notWatchTurn });
    expect(isError(result)).toBe(false);
    const body = JSON.parse(text(result));
    expect(body).toEqual(expect.objectContaining({ watching: true, project: "api", sessionId: SESSION, status: "active", notifyOn: ["done"] }));

    const listed = JSON.parse(text(chatListWatchesTool(ASSISTANT, { service })));
    expect(listed.watches.map((w: { watchId: string }) => w.watchId)).toEqual([body.watchId]);
    expect(JSON.parse(text(chatListWatchesTool("another-assistant", { service }))).watches).toEqual([]);

    const stopped = chatUnwatchTool(ASSISTANT, { watchId: body.watchId }, { service, watchTurn: notWatchTurn });
    expect(JSON.parse(text(stopped))).toEqual(expect.objectContaining({ stopped: true, status: "cancelled" }));
    expect(isError(chatUnwatchTool(ASSISTANT, { watchId: body.watchId }, { service, watchTurn: notWatchTurn }))).toBe(true);
  });

  it("tells the model notifyOn picks only the ends that wake it, never whether cards reach the user", () => {
    const deps = { service, watchTurn: notWatchTurn };
    const body = JSON.parse(text(chatWatchTool(ASSISTANT, { project: "api", sessionId: SESSION, notifyOn: ["done", "stopped"] }, deps)));
    expect(body.notifyOn).toEqual(["done", "stopped"]);
    expect(body.note).toContain("cards and questions go to the user directly whatever notifyOn says");
    chatUnwatchTool(ASSISTANT, { watchId: body.watchId }, deps);
    // The old "decision" kind is accepted and ignored; on its own it would wake for nothing.
    expect(JSON.parse(text(chatWatchTool(ASSISTANT, { project: "api", sessionId: SESSION, notifyOn: ["decision", "done"] }, deps))).notifyOn).toEqual(["done"]);
    const alone = chatWatchTool(ASSISTANT, { project: "api", sessionId: SESSION, notifyOn: ["decision"] }, deps);
    expect(text(alone)).toContain("cards go to the user whatever it says");
  });

  it("refuses to set or stop watches in a turn a watch started", () => {
    const watchTurn = () => true;
    const set = chatWatchTool(ASSISTANT, { project: "api", sessionId: SESSION }, { service, watchTurn });
    expect(isError(set)).toBe(true);
    expect(text(set)).toContain("Refused without asking");
    expect(isError(chatUnwatchTool(ASSISTANT, { watchId: "x" }, { service, watchTurn }))).toBe(true);
    expect(listAssistantWatches()).toHaveLength(0);
  });

  it("refuses what is not a chat of a registered project, and malformed arguments", () => {
    const deps = { service, watchTurn: notWatchTurn };
    expect(text(chatWatchTool(ASSISTANT, { project: "nope", sessionId: SESSION }, deps))).toContain("No registered project");
    expect(isError(chatWatchTool(ASSISTANT, { project: "api", sessionId: "7d2e5c8b-3a4e-4b6c-9d0e-1f2a3b4c5d6e" }, deps))).toBe(true);
    expect(text(chatWatchTool(ASSISTANT, { project: "api", sessionId: SESSION, notifyOn: ["exploded"] }, deps))).toContain("notifyOn");
    expect(text(chatWatchTool(ASSISTANT, { project: "api", sessionId: SESSION, notifyOn: [] }, deps))).toContain("notifyOn");
    expect(isError(chatUnwatchTool(ASSISTANT, {}, deps))).toBe(true);
    // An Assistant chat is never a target.
    setSessionAssistant(SESSION);
    try {
      expect(text(chatWatchTool(ASSISTANT, { project: "api", sessionId: SESSION }, deps))).toContain("PPM Assistant chat");
    } finally {
      getDb().run("UPDATE session_metadata SET assistant = 0 WHERE session_id = ?", [SESSION]);
    }
    expect(listAssistantWatches()).toHaveLength(0);
  });

  it("says so when the service is not running", () => {
    service.stop();
    expect(text(chatWatchTool(ASSISTANT, { project: "api", sessionId: SESSION }, { service, watchTurn: notWatchTurn }))).toContain("not available");
    expect(isError(chatListWatchesTool(ASSISTANT, { service }))).toBe(true);
  });
});

describe("chat_start with watch", () => {
  function deps(deliverError?: string) {
    const delivery: AssistantChatDelivery = {
      inspect: () => { throw new Error("not used"); },
      deliver: async (target) => {
        // The watch exists before the first message goes.
        expect(listAssistantWatches({ targetSessionId: target.sessionId })).toHaveLength(1);
        return deliverError ? { ok: false, error: deliverError } : { ok: true, sessionId: target.sessionId };
      },
    };
    const create = async (input: Record<string, unknown>) => ({ id: crypto.randomUUID(), providerId: String(input.providerId), title: "", createdAt: "" });
    return { delivery, create: create as never, broadcast: () => {}, watch: chatStartWatcher(ASSISTANT, service) };
  }
  const approve = async () => ({ verdict: "approved" as const });

  it("watches the new chat as running and says so", async () => {
    const result = await chatStart({ project: "api", text: "run the tests", permissionMode: "default", watch: true }, approve, deps());
    const body = JSON.parse(text(result));
    expect(body.watchId).toBeString();
    const [w] = listAssistantWatches();
    expect(w).toEqual(expect.objectContaining({ id: body.watchId, assistantSessionId: ASSISTANT, armedRunning: true, status: "active" }));
  });

  it("drops the watch when the first message never went", async () => {
    const result = await chatStart({ project: "api", text: "run the tests", permissionMode: "default", watch: true }, approve, deps("nope"));
    expect(isError(result)).toBe(true);
    expect(listAssistantWatches()[0]!.status).toBe("cancelled");
  });

  it("refuses a watch flag that is not a boolean", async () => {
    expect(text(await chatStart({ project: "api", text: "x", watch: "yes" }, approve, deps()))).toContain("`watch`");
  });
});
