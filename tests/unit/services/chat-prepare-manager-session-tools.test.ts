/**
 * A manager chat always gets the session-tools server attached — it is how it will report to PPM
 * Assistant — even with every session tool switched off in Settings → Tools, while an ordinary
 * chat gets it only when a tool is on. The tools themselves follow the switches for every chat,
 * the manager included: the endpoint lists none for either while they are off.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
import "../../test-setup.ts";
import { join } from "node:path";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { configService } from "../../../src/services/config.service.ts";
import { setSessionMetadata, setSessionProvider } from "../../../src/services/db.service.ts";
import { setServerListenAddress } from "../../../src/services/server-listen-address.ts";
import { managerChats } from "../../../src/services/assistant-managers/manager-chats.service.ts";
import { createSessionCollabMcpHandler, sessionToolOnFor } from "../../../src/services/session-collab/session-collab-endpoint.ts";
import { SESSION_TOOLS } from "../../../src/shared/ppm-tools.ts";
import type { AIProvider } from "../../../src/types/chat.ts";

const project = { name: "mgr-tools", path: join(process.env.PPM_HOME!, "mgr-tools") };
const stub: AIProvider = {
  id: "claude", name: "Claude",
  async createSession() { return { id: "x", providerId: "claude", title: "", createdAt: "" }; },
  async resumeSession() { return { id: "x", providerId: "claude", title: "", createdAt: "" }; },
  async listSessions() { return []; },
  async deleteSession() {},
  async *sendMessage() {},
};
let original: AIProvider | undefined;
let projectsBefore = configService.get("projects");

beforeEach(() => {
  original = providerRegistry.get("claude");
  providerRegistry.register(stub);
  setServerListenAddress(8126, "0.0.0.0");
  projectsBefore = configService.get("projects");
  (configService as any).config.projects = [...projectsBefore, project];
  managerChats.unassign(project.name);
  configService.get("ai").ppm_tools = Object.fromEntries(SESSION_TOOLS.map((tool) => [tool, false]));
});
afterEach(() => {
  managerChats.unassign(project.name);
  delete (configService as any).config.ai.ppm_tools;
  (configService as any).config.projects = projectsBefore;
  if (original) providerRegistry.register(original);
  setServerListenAddress(0, "");
});

function chat(): string {
  const id = `chat-${crypto.randomUUID()}`;
  setSessionMetadata(id, project.name, project.path);
  setSessionProvider(id, "claude");
  return id;
}

it("attaches the session tools to a manager chat with every one switched off, and to no other chat", async () => {
  const manager = chat();
  const ordinary = chat();
  await managerChats.assign(project.name, manager);
  const forManager = await chatService.prepareSendOptions("claude", manager, "hi");
  expect(forManager.sessionCollabMcp?.url).toBe("http://127.0.0.1:8126/api/sessions-mcp");
  expect(await chatService.prepareSendOptions("claude", ordinary, "hi")).not.toHaveProperty("sessionCollabMcp");
  managerChats.unassign(project.name);
  expect(await chatService.prepareSendOptions("claude", manager, "hi")).not.toHaveProperty("sessionCollabMcp");
});

it("lists the tools by the switches for the manager as for any chat", async () => {
  const manager = chat();
  const ordinary = chat();
  await managerChats.assign(project.name, manager);
  const handler = createSessionCollabMcpHandler({
    resolveToken: (token) => (token ? { sessionId: token } as never : null),
    env: () => { throw new Error("not called"); },
    enabled: sessionToolOnFor,
  });
  const list = async (sessionId: string) => {
    const { Hono } = await import("hono");
    const app = new Hono();
    app.post("/mcp", handler);
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${sessionId}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    return ((await res.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
  };
  expect(await list(manager)).toEqual([]);
  expect(await list(ordinary)).toEqual([]);
  configService.get("ai").ppm_tools = Object.fromEntries(SESSION_TOOLS.map((tool) => [tool, true]));
  expect((await list(manager)).sort()).toEqual([...SESSION_TOOLS].sort());
  expect((await list(ordinary)).sort()).toEqual([...SESSION_TOOLS].sort());
});
