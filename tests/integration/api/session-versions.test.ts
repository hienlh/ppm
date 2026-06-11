import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import "../../test-setup.ts";
import { configService } from "../../../src/services/config.service.ts";
import { app } from "../../../src/server/index.ts";
import { setDb, openTestDb } from "../../../src/services/db.service.ts";
import { recordBranch, getRootId } from "../../../src/services/session-branch.service.ts";

beforeAll(() => {
  (configService as any).config.auth = { enabled: false, token: "" };
  const projects = configService.get("projects");
  if (!projects.find((p) => p.name === "test")) {
    projects.push({ name: "test", path: process.cwd() });
    configService.set("projects", projects);
  }
});

beforeEach(() => {
  setDb(openTestDb());
});

const PROJECT = "test";

async function req(path: string, init?: RequestInit) {
  const url = `http://localhost/api/project/${PROJECT}${path}`;
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  return app.request(new Request(url, { ...init, headers }));
}

describe("GET /chat/sessions/:id/versions", () => {
  it("returns ordered versions + currentIndex viewing the parent", async () => {
    recordBranch("c1", "P", "F", 2);
    recordBranch("c2", "P", "F", 2);
    const res = await req("/chat/sessions/P/versions?ordinal=2&providerId=mock");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as any;
    expect(data.versions.map((v: any) => v.id)).toEqual(["P", "c1", "c2"]);
    expect(data.currentIndex).toBe(0);
  });

  it("computes currentIndex viewing a child", async () => {
    recordBranch("c1", "P", "F", 2);
    recordBranch("c2", "P", "F", 2);
    const res = await req("/chat/sessions/c2/versions?ordinal=2&providerId=mock");
    const { data } = (await res.json()) as any;
    expect(data.currentIndex).toBe(2);
  });

  it("400 when no fork exists at the ordinal", async () => {
    const res = await req("/chat/sessions/P/versions?ordinal=9&providerId=mock");
    expect(res.status).toBe(400);
  });

  it("400 when ordinal missing", async () => {
    const res = await req("/chat/sessions/P/versions?providerId=mock");
    expect(res.status).toBe(400);
  });
});

describe("DELETE /chat/sessions/:id — leaf-only branch guard", () => {
  it("blocks deleting a session that has edited children (409)", async () => {
    const createRes = await req("/chat/sessions", {
      method: "POST",
      body: JSON.stringify({ providerId: "mock", title: "Parent" }),
    });
    const { data: parent } = (await createRes.json()) as any;
    recordBranch("child-x", parent.id, "F", 2);

    const delRes = await req(`/chat/sessions/${parent.id}?providerId=mock`, { method: "DELETE" });
    expect(delRes.status).toBe(409);
  });

  it("deletes a leaf and cleans its branch row", async () => {
    const createRes = await req("/chat/sessions", {
      method: "POST",
      body: JSON.stringify({ providerId: "mock", title: "Leaf" }),
    });
    const { data: leaf } = (await createRes.json()) as any;
    recordBranch(leaf.id, "root-A", "F", 2);
    expect(getRootId(leaf.id)).toBe("root-A");

    const delRes = await req(`/chat/sessions/${leaf.id}?providerId=mock`, { method: "DELETE" });
    expect(delRes.status).toBe(200);
    expect(getRootId(leaf.id)).toBeNull();
  });
});
