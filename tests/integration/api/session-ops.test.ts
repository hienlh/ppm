import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import "../../test-setup.ts";
import { configService } from "../../../src/services/config.service.ts";
import { app } from "../../../src/server/index.ts";
import {
  setDb,
  openTestDb,
  setSessionMapping,
  getSessionMapping,
  setSessionTitle,
  getSessionTitle,
  pinSession,
  getPinnedSessionIds,
} from "../../../src/services/db.service.ts";

beforeAll(() => {
  (configService as any).config.auth = { enabled: false, token: "" };
  const projects = configService.get("projects");
  if (!projects.find((p) => p.name === "test")) {
    projects.push({ name: "test", path: process.cwd() });
    configService.set("projects", projects);
  }
});

beforeEach(() => {
  // Fresh DB per test so DB-level side-effects don't leak
  setDb(openTestDb());
});

const PROJECT = "test";

async function req(path: string, init?: RequestInit) {
  const url = `http://localhost/api/project/${PROJECT}${path}`;
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  return app.request(new Request(url, { ...init, headers }));
}

describe("Session Delete — DB cleanup", () => {
  it("cleans up session_map on delete", async () => {
    // Create session via mock provider
    const createRes = await req("/chat/sessions", {
      method: "POST",
      body: JSON.stringify({ providerId: "mock", title: "Del Map" }),
    });
    const { data: session } = (await createRes.json()) as any;

    // Simulate a mapping (as SDK provider would create)
    setSessionMapping(session.id, "sdk-id-123");
    expect(getSessionMapping(session.id)).toBe("sdk-id-123");

    // Delete
    const delRes = await req(`/chat/sessions/${session.id}?providerId=mock`, {
      method: "DELETE",
    });
    const json = (await delRes.json()) as any;
    expect(json.ok).toBe(true);

    // Mapping should be gone
    expect(getSessionMapping(session.id)).toBeNull();
  });

  it("cleans up session_titles on delete", async () => {
    const createRes = await req("/chat/sessions", {
      method: "POST",
      body: JSON.stringify({ providerId: "mock", title: "Del Title" }),
    });
    const { data: session } = (await createRes.json()) as any;

    // Simulate a title (resolves via sdkId which is session.id when no mapping)
    setSessionTitle(session.id, "Custom Title");
    expect(getSessionTitle(session.id)).toBe("Custom Title");

    const delRes = await req(`/chat/sessions/${session.id}?providerId=mock`, {
      method: "DELETE",
    });
    expect(((await delRes.json()) as any).ok).toBe(true);

    // Title should be gone
    expect(getSessionTitle(session.id)).toBeNull();
  });

  it("cleans up session_pins on delete", async () => {
    const createRes = await req("/chat/sessions", {
      method: "POST",
      body: JSON.stringify({ providerId: "mock", title: "Del Pin" }),
    });
    const { data: session } = (await createRes.json()) as any;

    pinSession(session.id);
    expect(getPinnedSessionIds().has(session.id)).toBe(true);

    const delRes = await req(`/chat/sessions/${session.id}?providerId=mock`, {
      method: "DELETE",
    });
    expect(((await delRes.json()) as any).ok).toBe(true);

    expect(getPinnedSessionIds().has(session.id)).toBe(false);
  });

  it("cleans up mapped sdkId title + pin", async () => {
    const createRes = await req("/chat/sessions", {
      method: "POST",
      body: JSON.stringify({ providerId: "mock", title: "Mapped" }),
    });
    const { data: session } = (await createRes.json()) as any;

    // Simulate SDK mapping — title/pin are keyed by sdkId
    const sdkId = "sdk-mapped-456";
    setSessionMapping(session.id, sdkId);
    setSessionTitle(sdkId, "SDK Title");
    pinSession(sdkId);

    const delRes = await req(`/chat/sessions/${session.id}?providerId=mock`, {
      method: "DELETE",
    });
    expect(((await delRes.json()) as any).ok).toBe(true);

    expect(getSessionMapping(session.id)).toBeNull();
    expect(getSessionTitle(sdkId)).toBeNull();
    expect(getPinnedSessionIds().has(sdkId)).toBe(false);
  });
});

describe("Session Fork — route dispatch", () => {
  it("fork returns 400 for provider without fork support", async () => {
    // Mock provider has no setForkSource or forkAtMessage
    const createRes = await req("/chat/sessions", {
      method: "POST",
      body: JSON.stringify({ providerId: "mock", title: "Source" }),
    });
    const { data: source } = (await createRes.json()) as any;

    const forkRes = await req(`/chat/sessions/${source.id}/fork?providerId=mock`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const json = (await forkRes.json()) as any;

    expect(json.ok).toBe(false);
    expect(json.error).toContain("does not support forking");
  });

  it("fork with messageId returns 400 for provider without forkAtMessage", async () => {
    const createRes = await req("/chat/sessions", {
      method: "POST",
      body: JSON.stringify({ providerId: "mock", title: "Mid Fork" }),
    });
    const { data: source } = (await createRes.json()) as any;

    const forkRes = await req(`/chat/sessions/${source.id}/fork?providerId=mock`, {
      method: "POST",
      body: JSON.stringify({ messageId: "msg-uuid-123" }),
    });
    const json = (await forkRes.json()) as any;

    expect(json.ok).toBe(false);
    expect(json.error).toContain("does not support forking");
  });

  it("fork with unknown provider returns 404", async () => {
    const createRes = await req("/chat/sessions", {
      method: "POST",
      body: JSON.stringify({ providerId: "mock", title: "No Provider" }),
    });
    const { data: source } = (await createRes.json()) as any;

    const forkRes = await req(`/chat/sessions/${source.id}/fork?providerId=nonexistent`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const json = (await forkRes.json()) as any;

    expect(json.ok).toBe(false);
    expect(json.error).toContain("not found");
  });
});
