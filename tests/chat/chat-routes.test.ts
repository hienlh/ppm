import { describe, it, expect } from "bun:test";
import "./test-setup.ts"; // disable auth
import { app } from "../../src/server/index.ts";

async function req(path: string, init?: RequestInit) {
  const url = `http://localhost${path}`;
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  return app.request(new Request(url, { ...init, headers }));
}

describe("Chat REST API", () => {
  it("GET /api/chat/providers lists available providers", async () => {
    const res = await req("/api/chat/providers");
    const json = await res.json() as any;

    expect(json.ok).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);
    const ids = json.data.map((p: any) => p.id);
    expect(ids).toContain("claude-sdk");
    expect(ids).toContain("mock");
  });

  it("POST /api/chat/sessions creates a session", async () => {
    const res = await req("/api/chat/sessions", {
      method: "POST",
      body: JSON.stringify({ providerId: "mock", projectName: "test" }),
    });
    const json = await res.json() as any;

    expect(res.status).toBe(201);
    expect(json.ok).toBe(true);
    expect(json.data.id).toBeTruthy();
    expect(json.data.providerId).toBe("mock");
    expect(json.data.projectName).toBe("test");
  });

  it("GET /api/chat/sessions lists sessions", async () => {
    await req("/api/chat/sessions", {
      method: "POST",
      body: JSON.stringify({ providerId: "mock", title: "Listed" }),
    });

    const res = await req("/api/chat/sessions?providerId=mock");
    const json = await res.json() as any;

    expect(json.ok).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/chat/sessions?providerId=mock filters by provider", async () => {
    const res = await req("/api/chat/sessions?providerId=mock");
    const json = await res.json() as any;

    expect(json.ok).toBe(true);
    expect(json.data.every((s: any) => s.providerId === "mock")).toBe(true);
  });

  it("GET /api/chat/sessions/:id/messages returns history", async () => {
    const createRes = await req("/api/chat/sessions", {
      method: "POST",
      body: JSON.stringify({ providerId: "mock" }),
    });
    const { data: session } = await createRes.json() as any;

    const msgRes = await req(`/api/chat/sessions/${session.id}/messages?providerId=mock`);
    const json = await msgRes.json() as any;

    expect(json.ok).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);
  });

  it("DELETE /api/chat/sessions/:id deletes a session", async () => {
    const createRes = await req("/api/chat/sessions", {
      method: "POST",
      body: JSON.stringify({ providerId: "mock", title: "To delete" }),
    });
    const { data: session } = await createRes.json() as any;

    const delRes = await req(`/api/chat/sessions/${session.id}?providerId=mock`, {
      method: "DELETE",
    });
    const json = await delRes.json() as any;

    expect(json.ok).toBe(true);
    expect(json.data.deleted).toBe(session.id);
  });

  it("health endpoint works without auth", async () => {
    const res = await app.request(new Request("http://localhost/api/health"));
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
  });
});
