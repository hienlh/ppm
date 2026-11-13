/**
 * Forking a chat an extension bound — the history's Fork, and editing an earlier message,
 * which forks at that message — yields a chat exactly as locked as its source: the same
 * owner, instructions, toolsets and tool policy. Without them the fork would inherit the
 * conversation and run it as an ordinary chat with every tool.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { configService } from "../../../src/services/config.service.ts";
import { app } from "../../../src/server/index.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import {
  getExtensionSessionBinding, getSessionCreatedByExtension, insertExtensionSessionBinding,
  setSessionCreatedByExtension, updateExtensionSessionBinding,
} from "../../../src/services/db.service.ts";

const PROJECT = "test";
const EXT = "fork-probe-ext";
const POLICY = JSON.stringify({ readRoots: ["/r"], writeRoots: ["/r/.proposals"] });

const mock = providerRegistry.get("mock") as any;
let originalFork: unknown;

beforeAll(() => {
  (configService as any).config.auth = { enabled: false, token: "" };
  const projects = configService.get("projects");
  if (!projects.find((p) => p.name === PROJECT)) configService.set("projects", [...projects, { name: PROJECT, path: process.cwd() }]);
  // The mock provider cannot fork at a message; this one forks into a fresh session of its own.
  originalFork = mock.forkAtMessage;
  mock.forkAtMessage = async () => ({ sessionId: (await mock.createSession({ title: "fork" })).id });
});

afterAll(() => {
  if (originalFork === undefined) delete mock.forkAtMessage;
  else mock.forkAtMessage = originalFork;
});

async function req(path: string, body: unknown) {
  const headers = new Headers({ "Content-Type": "application/json" });
  return app.request(new Request(`http://localhost/api/project/${PROJECT}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
}

async function boundSource(): Promise<string> {
  const res = await req("/chat/sessions", { providerId: "mock", title: "Manager" });
  const { data } = (await res.json()) as { data: { id: string } };
  insertExtensionSessionBinding(data.id, EXT);
  setSessionCreatedByExtension(data.id, EXT);
  updateExtensionSessionBinding(data.id, { instructions: "# Manager", toolsetsJson: "[\"fg\"]", toolPolicyJson: POLICY });
  return data.id;
}

function expectBoundLikeSource(forkId: string) {
  expect(getExtensionSessionBinding(forkId)).toMatchObject({
    session_id: forkId, extension_id: EXT, instructions: "# Manager", toolsets_json: "[\"fg\"]", tool_policy_json: POLICY,
  });
  expect(getSessionCreatedByExtension(forkId)).toBe(EXT);
}

describe("forking a chat an extension bound", () => {
  it("editing an earlier message carries the binding and the creator to the new version", async () => {
    const source = await boundSource();
    const res = await req(`/chat/sessions/${source}/fork?providerId=mock&mode=edit`, { messageId: "msg-1" });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; forkedFrom: string } };
    expect(data.forkedFrom).toBe(source);
    expectBoundLikeSource(data.id);
    // The source keeps its own.
    expect(getExtensionSessionBinding(source)?.tool_policy_json).toBe(POLICY);
  });

  it("forking from the start carries them too", async () => {
    const source = await boundSource();
    const res = await req(`/chat/sessions/${source}/fork?providerId=mock`, {});
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    expectBoundLikeSource(data.id);
  });

  it("leaves a fork of an ordinary chat ordinary", async () => {
    const created = await req("/chat/sessions", { providerId: "mock", title: "Plain" });
    const { data: source } = (await created.json()) as { data: { id: string } };
    for (const body of [{ messageId: "msg-1" }, {}]) {
      const res = await req(`/chat/sessions/${source.id}/fork?providerId=mock`, body);
      const { data } = (await res.json()) as { data: { id: string } };
      expect(getExtensionSessionBinding(data.id)).toBeNull();
      expect(getSessionCreatedByExtension(data.id)).toBeNull();
    }
  });
});
