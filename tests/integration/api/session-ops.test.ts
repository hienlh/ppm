import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import "../../test-setup.ts";
import { configService } from "../../../src/services/config.service.ts";
import { app } from "../../../src/server/index.ts";
import {
  setDb,
  openTestDb,
  setSessionMetadata,
  getSessionProjectPath,
  deleteSessionMapping,
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
  it("cleans up session_metadata on delete", async () => {
    // Create session via mock provider
    const createRes = await req("/chat/sessions", {
      method: "POST",
      body: JSON.stringify({ providerId: "mock", title: "Del Meta" }),
    });
    const { data: session } = (await createRes.json()) as any;

    // Simulate metadata (as SDK provider would create)
    setSessionMetadata(session.id, "test-project", "/home/user/proj");
    expect(getSessionProjectPath(session.id)).toBe("/home/user/proj");

    // Delete
    const delRes = await req(`/chat/sessions/${session.id}?providerId=mock`, {
      method: "DELETE",
    });
    const json = (await delRes.json()) as any;
    expect(json.ok).toBe(true);

    // Metadata should be gone
    expect(getSessionProjectPath(session.id)).toBeNull();
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

  it("cleans up metadata + title + pin on delete", async () => {
    const createRes = await req("/chat/sessions", {
      method: "POST",
      body: JSON.stringify({ providerId: "mock", title: "Full Cleanup" }),
    });
    const { data: session } = (await createRes.json()) as any;

    // Simulate all DB artifacts for a session
    setSessionMetadata(session.id, "proj", "/path");
    setSessionTitle(session.id, "Custom Title");
    pinSession(session.id);

    const delRes = await req(`/chat/sessions/${session.id}?providerId=mock`, {
      method: "DELETE",
    });
    expect(((await delRes.json()) as any).ok).toBe(true);

    expect(getSessionProjectPath(session.id)).toBeNull();
    expect(getSessionTitle(session.id)).toBeNull();
    expect(getPinnedSessionIds().has(session.id)).toBe(false);
  });
});

describe("Session Fork — route dispatch", () => {
  it("fork without messageId creates fresh empty session", async () => {
    // Fork at first message — no previous message ID, creates new empty session
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

    expect(json.ok).toBe(true);
    expect(json.data.forkedFrom).toBe(source.id);
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

  it("fork with messageId that SDK can't find returns 400 (not silent empty session)", async () => {
    // Regression: previously, when SDK forkSession threw "Message not found"
    // (e.g., ghost uuid from interrupted streaming), backend silently created
    // a fresh empty session and returned 201. This produced an empty fork tab
    // with no user feedback. New behavior: return 400 with the SDK error.
    const { providerRegistry } = await import("../../../src/providers/registry.ts");
    const mock = providerRegistry.get("mock") as any;
    const original = mock.forkAtMessage;
    mock.forkAtMessage = async () => {
      throw new Error("Message ghost-uuid not found in session");
    };
    try {
      const createRes = await req("/chat/sessions", {
        method: "POST",
        body: JSON.stringify({ providerId: "mock", title: "Ghost Fork" }),
      });
      const { data: source } = (await createRes.json()) as any;

      const forkRes = await req(`/chat/sessions/${source.id}/fork?providerId=mock`, {
        method: "POST",
        body: JSON.stringify({ messageId: "ghost-uuid" }),
      });
      const json = (await forkRes.json()) as any;

      expect(forkRes.status).toBe(400);
      expect(json.ok).toBe(false);
      expect(json.error).toContain("Cannot fork at message");
      expect(json.error).toContain("not found");
    } finally {
      // Restore: delete property so provider goes back to not supporting fork
      if (original === undefined) delete mock.forkAtMessage;
      else mock.forkAtMessage = original;
    }
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
