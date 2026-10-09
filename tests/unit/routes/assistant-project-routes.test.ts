/**
 * The PPM Assistant's virtual project resolves on the chat path and nowhere else: its chats
 * run in an empty folder under the PPM dir, and no terminal, LSP, git, file tree, workspace,
 * tag or design route may be rooted there. Nor may a real project take the name.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import "../../test-setup.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { projectScopedRouter } from "../../../src/server/routes/project-scoped.ts";
import { mcpAuthRoutes } from "../../../src/server/routes/mcp-auth.ts";
import { terminalWebSocket } from "../../../src/server/ws/terminal.ts";
import { lspWebSocket } from "../../../src/server/ws/lsp.ts";
import { resolveChatProjectPath } from "../../../src/server/helpers/resolve-chat-project.ts";
import { resolveProjectPath } from "../../../src/server/helpers/resolve-project.ts";
import { assistantWorkDir } from "../../../src/services/assistant/assistant-work-dir.ts";
import { projectService } from "../../../src/services/project.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { getDb, getSessionIsAssistant } from "../../../src/services/db.service.ts";
import { ASSISTANT_PROJECT_NAME } from "../../../src/shared/assistant-project.ts";
import type { AIProvider, SessionConfig } from "../../../src/types/chat.ts";

const app = new Hono();
app.route("/api/project/:projectName", projectScopedRouter);
app.route("/api/mcp-auth", mcpAuthRoutes);

const A = ASSISTANT_PROJECT_NAME;
const created: SessionConfig[] = [];
let seq = 0;

function stubProvider(id: string, assistant: boolean): AIProvider {
  return {
    id, name: id, supportsAssistantSessions: assistant,
    async createSession(config) {
      created.push(config);
      return { id: `${id}-${++seq}`, providerId: id, title: "", createdAt: "", projectPath: config.projectPath };
    },
    async resumeSession() { return { id: "x", providerId: id, title: "", createdAt: "" }; },
    async listSessions() { return []; },
    async deleteSession() {},
    async *sendMessage() {},
  };
}

const postJson = (path: string, body: unknown) =>
  app.request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

let projectDir: string;
let savedProjects: unknown;

beforeEach(() => {
  getDb().run("DELETE FROM session_metadata");
  created.length = 0;
  providerRegistry.register(stubProvider("stub-assistant", true));
  providerRegistry.register(stubProvider("stub-plain", false));
  projectDir = mkdtempSync(join(tmpdir(), "ppm-assistant-proj-"));
  savedProjects = configService.get("projects");
  // A project registered at the server's own working directory: the case where the path
  // fallback in `resolveProjectPath` would turn the reserved name into a folder inside it.
  configService.set("projects", [{ name: "real", path: projectDir }, { name: "here", path: process.cwd() }]);
});

afterEach(() => {
  configService.set("projects", savedProjects as never);
  rmSync(projectDir, { recursive: true, force: true });
});

describe("the Assistant's virtual project", () => {
  it("resolves to the Assistant work dir on the chat path only", () => {
    expect(resolveChatProjectPath(A)).toBe(assistantWorkDir());
    expect(resolveChatProjectPath("real")).toBe(resolve(projectDir));
    // Unchanged for everyone else — and, with a project at the cwd, not a refusal either,
    // which is why the non-chat doors check the name themselves.
    expect(resolveProjectPath(A)).toBe(resolve(process.cwd(), A));
  });

  it("answers the /chat sub-router and refuses every other project route", async () => {
    expect((await app.request(`http://localhost/api/project/${A}/chat/providers`)).status).toBe(200);
    for (const path of ["git/status", "workspace", "files/tree", "files/raw?path=a", "tags", "designs", "lsp/status", "files/download/token"]) {
      const res = await app.request(`http://localhost/api/project/${A}/${path}`);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
    // A real project still reaches its non-chat routes through the same middleware.
    expect((await app.request("http://localhost/api/project/real/tags")).status).not.toBe(404);
  });

  it("creates every session there as an Assistant session, in the work dir, without a warm spare", async () => {
    const res = await postJson(`/api/project/${A}/chat/sessions`, { providerId: "stub-assistant", assistant: true });
    expect(res.status).toBe(201);
    const session = ((await res.json()) as { data: { id: string } }).data;
    expect(getSessionIsAssistant(session.id)).toBe(true);
    expect(created.at(-1)).toMatchObject({ projectName: A, projectPath: assistantWorkDir(), adoptWarmSpare: false });

    // The flag is not needed: the project decides.
    const implicit = ((await (await postJson(`/api/project/${A}/chat/sessions`, { providerId: "stub-assistant" })).json()) as { data: { id: string } }).data;
    expect(getSessionIsAssistant(implicit.id)).toBe(true);
  });

  it("refuses a mismatched flag, a design slug, and a provider that cannot enforce the policy", async () => {
    expect((await postJson("/api/project/real/chat/sessions", { providerId: "stub-assistant", assistant: true })).status).toBe(400);
    expect((await postJson(`/api/project/${A}/chat/sessions`, { providerId: "stub-assistant", assistant: false })).status).toBe(400);
    expect((await postJson(`/api/project/${A}/chat/sessions`, { providerId: "stub-assistant", designSlug: "landing" })).status).toBe(400);
    expect((await postJson(`/api/project/${A}/chat/sessions`, { providerId: "stub-plain" })).status).toBe(400);
    expect(created).toHaveLength(0);
    // An ordinary project's session is not marked.
    const plain = ((await (await postJson("/api/project/real/chat/sessions", { providerId: "stub-plain" })).json()) as { data: { id: string } }).data;
    expect(getSessionIsAssistant(plain.id)).toBe(false);
  });

  it("starts no terminal and no language server there", () => {
    const sent: string[] = [];
    terminalWebSocket.open({ data: { type: "terminal", id: "new", projectName: A }, send: (m) => sent.push(m) });
    expect(JSON.parse(sent[0]!)).toEqual({ type: "error", message: `Project not found: ${A}` });

    const close = mock((_code?: number, _reason?: string) => {});
    lspWebSocket.open({ data: { type: "lsp", projectName: A }, send: () => {}, close });
    expect(close).toHaveBeenCalledWith(1008, `Project not found: ${A}`);
  });

  it("is not an MCP sign-in directory", async () => {
    expect((await app.request(`http://localhost/api/mcp-auth/status?project=${A}`)).status).toBe(404);
  });

  it("cannot be registered or renamed into", () => {
    expect(() => projectService.add(projectDir, A)).toThrow("reserved");
    expect(() => projectService.update("real", { name: A })).toThrow("reserved");
    expect(configService.get("projects").map((p) => p.name)).toEqual(["real", "here"]);
  });
});
