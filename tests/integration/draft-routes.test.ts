import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import "../test-setup.ts"; // disable auth
import { configService } from "../../src/services/config.service.ts";
import { app } from "../../src/server/index.ts";

/**
 * Integration tests for Draft API routes
 * Tests the REST API endpoints for draft CRUD operations
 */

const PROJECT = "test";

async function req(path: string, init?: RequestInit) {
  const url = `http://localhost/api/project/${PROJECT}${path}`;
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  return app.request(new Request(url, { ...init, headers }));
}

beforeAll(() => {
  const { setDb, openTestDb } = require("../../src/services/db.service.ts");
  setDb(openTestDb());
  (configService as any).config.auth = { enabled: false, token: "" };
  const projects = configService.get("projects");
  if (!projects.find((p) => p.name === "test")) {
    projects.push({ name: "test", path: process.cwd() });
    configService.set("projects", projects);
  }
});

describe("Draft API Routes", () => {
  describe("GET /chat/drafts/:sessionId", () => {
    it("returns null for non-existent draft", async () => {
      const res = await req("/chat/drafts/non-existent-session");
      const json = await res.json() as any;

      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.data).toBeNull();
    });

    it("returns draft data when it exists", async () => {
      const sessionId = "test-session-get-" + Date.now();

      // Create draft first
      await req(`/chat/drafts/${sessionId}`, {
        method: "PUT",
        body: JSON.stringify({ content: "test content" }),
      });

      // Now retrieve it
      const res = await req(`/chat/drafts/${sessionId}`);
      const json = await res.json() as any;

      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.data).not.toBeNull();
      expect(json.data.content).toBe("test content");
      expect(json.data.attachments).toBe("[]");
      expect(json.data.updatedAt).toBeTruthy();
    });

    it("returns draft with attachments", async () => {
      const sessionId = "test-session-attachments-" + Date.now();
      const attachments = JSON.stringify([{ name: "file.txt", size: 100 }]);

      await req(`/chat/drafts/${sessionId}`, {
        method: "PUT",
        body: JSON.stringify({ content: "content", attachments }),
      });

      const res = await req(`/chat/drafts/${sessionId}`);
      const json = await res.json() as any;

      expect(json.data.attachments).toBe(attachments);
    });
  });

  describe("PUT /chat/drafts/:sessionId", () => {
    it("creates a new draft", async () => {
      const sessionId = "test-session-create-" + Date.now();
      const content = "new draft content";

      const res = await req(`/chat/drafts/${sessionId}`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      });
      const json = await res.json() as any;

      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.data.saved).toBe(true);

      // Verify it was actually saved
      const getRes = await req(`/chat/drafts/${sessionId}`);
      const getData = await getRes.json() as any;
      expect(getData.data.content).toBe(content);
    });

    it("updates existing draft", async () => {
      const sessionId = "test-session-update-" + Date.now();

      // Create initial
      await req(`/chat/drafts/${sessionId}`, {
        method: "PUT",
        body: JSON.stringify({ content: "original" }),
      });

      // Update it
      const updateRes = await req(`/chat/drafts/${sessionId}`, {
        method: "PUT",
        body: JSON.stringify({ content: "updated" }),
      });
      const updateJson = await updateRes.json() as any;
      expect(updateJson.ok).toBe(true);

      // Verify updated content
      const getRes = await req(`/chat/drafts/${sessionId}`);
      const getData = await getRes.json() as any;
      expect(getData.data.content).toBe("updated");
    });

    it("accepts attachments in JSON format", async () => {
      const sessionId = "test-session-attach-" + Date.now();
      const attachments = JSON.stringify({ files: ["a.txt", "b.pdf"] });

      const res = await req(`/chat/drafts/${sessionId}`, {
        method: "PUT",
        body: JSON.stringify({ content: "with files", attachments }),
      });
      const json = await res.json() as any;

      expect(json.ok).toBe(true);

      const getRes = await req(`/chat/drafts/${sessionId}`);
      const getData = await getRes.json() as any;
      expect(getData.data.attachments).toBe(attachments);
    });

    it("allows empty content", async () => {
      const sessionId = "test-session-empty-" + Date.now();

      const res = await req(`/chat/drafts/${sessionId}`, {
        method: "PUT",
        body: JSON.stringify({ content: "" }),
      });
      const json = await res.json() as any;

      expect(json.ok).toBe(true);

      const getRes = await req(`/chat/drafts/${sessionId}`);
      const getData = await getRes.json() as any;
      expect(getData.data.content).toBe("");
    });

    it("works without attachments field", async () => {
      const sessionId = "test-session-no-attach-" + Date.now();

      const res = await req(`/chat/drafts/${sessionId}`, {
        method: "PUT",
        body: JSON.stringify({ content: "content only" }),
      });
      const json = await res.json() as any;

      expect(json.ok).toBe(true);

      const getRes = await req(`/chat/drafts/${sessionId}`);
      const getData = await getRes.json() as any;
      expect(getData.data.attachments).toBe("[]");
    });

    it("truncates content over 50KB silently", async () => {
      const sessionId = "test-session-truncate-" + Date.now();
      const largeContent = "x".repeat(60 * 1024); // 60KB

      const res = await req(`/chat/drafts/${sessionId}`, {
        method: "PUT",
        body: JSON.stringify({ content: largeContent }),
      });
      const json = await res.json() as any;

      expect(json.ok).toBe(true);

      // Verify truncation happened
      const getRes = await req(`/chat/drafts/${sessionId}`);
      const getData = await getRes.json() as any;
      expect(getData.data.content.length).toBeLessThanOrEqual(50 * 1024);
      expect(getData.data.content.length).toBe(50 * 1024);
    });

    it("accepts content at exactly 50KB limit", async () => {
      const sessionId = "test-session-50kb-" + Date.now();
      const contentAt50KB = "y".repeat(50 * 1024);

      const res = await req(`/chat/drafts/${sessionId}`, {
        method: "PUT",
        body: JSON.stringify({ content: contentAt50KB }),
      });
      const json = await res.json() as any;

      expect(json.ok).toBe(true);

      const getRes = await req(`/chat/drafts/${sessionId}`);
      const getData = await getRes.json() as any;
      expect(getData.data.content.length).toBe(50 * 1024);
      expect(getData.data.content).toBe(contentAt50KB);
    });

    it("handles unicode and special characters", async () => {
      const sessionId = "test-session-unicode-" + Date.now();
      const special = "こんにちは 🚀 特殊문자 مرحبا";

      const res = await req(`/chat/drafts/${sessionId}`, {
        method: "PUT",
        body: JSON.stringify({ content: special }),
      });
      const json = await res.json() as any;

      expect(json.ok).toBe(true);

      const getRes = await req(`/chat/drafts/${sessionId}`);
      const getData = await getRes.json() as any;
      expect(getData.data.content).toBe(special);
    });

    it("returns 200 even if body is missing content field (defaults to empty)", async () => {
      const sessionId = "test-session-missing-content-" + Date.now();

      const res = await req(`/chat/drafts/${sessionId}`, {
        method: "PUT",
        body: JSON.stringify({ attachments: "[]" }),
      });
      const json = await res.json() as any;

      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);

      const getRes = await req(`/chat/drafts/${sessionId}`);
      const getData = await getRes.json() as any;
      expect(getData.data.content).toBe("");
    });
  });

  describe("DELETE /chat/drafts/:sessionId", () => {
    it("removes a draft", async () => {
      const sessionId = "test-session-del-" + Date.now();

      // Create draft
      await req(`/chat/drafts/${sessionId}`, {
        method: "PUT",
        body: JSON.stringify({ content: "to delete" }),
      });

      // Verify it exists
      let getRes = await req(`/chat/drafts/${sessionId}`);
      let getData = await getRes.json() as any;
      expect(getData.data).not.toBeNull();

      // Delete it
      const delRes = await req(`/chat/drafts/${sessionId}`, {
        method: "DELETE",
      });
      const delJson = await delRes.json() as any;

      expect(delRes.status).toBe(200);
      expect(delJson.ok).toBe(true);
      expect(delJson.data.deleted).toBe(true);

      // Verify it's gone
      getRes = await req(`/chat/drafts/${sessionId}`);
      getData = await getRes.json() as any;
      expect(getData.data).toBeNull();
    });

    it("returns 200 even if draft doesn't exist (idempotent)", async () => {
      const sessionId = "test-session-nonexistent-del-" + Date.now();

      const res = await req(`/chat/drafts/${sessionId}`, {
        method: "DELETE",
      });
      const json = await res.json() as any;

      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.data.deleted).toBe(true);
    });

    it("does not affect other drafts in same project", async () => {
      const session1 = "test-session-1-" + Date.now();
      const session2 = "test-session-2-" + Date.now();

      // Create two drafts
      await req(`/chat/drafts/${session1}`, {
        method: "PUT",
        body: JSON.stringify({ content: "draft 1" }),
      });
      await req(`/chat/drafts/${session2}`, {
        method: "PUT",
        body: JSON.stringify({ content: "draft 2" }),
      });

      // Delete session 1
      await req(`/chat/drafts/${session1}`, { method: "DELETE" });

      // Verify session 1 is gone
      let res1 = await req(`/chat/drafts/${session1}`);
      let data1 = await res1.json() as any;
      expect(data1.data).toBeNull();

      // Verify session 2 still exists
      let res2 = await req(`/chat/drafts/${session2}`);
      let data2 = await res2.json() as any;
      expect(data2.data).not.toBeNull();
      expect(data2.data.content).toBe("draft 2");
    });
  });

  describe("Multi-operation sequences", () => {
    it("create → read → update → read → delete → read works correctly", async () => {
      const sessionId = "test-session-full-flow-" + Date.now();

      // Create
      await req(`/chat/drafts/${sessionId}`, {
        method: "PUT",
        body: JSON.stringify({ content: "initial" }),
      });

      // Read 1
      let res = await req(`/chat/drafts/${sessionId}`);
      let data = await res.json() as any;
      expect(data.data.content).toBe("initial");

      // Update
      await req(`/chat/drafts/${sessionId}`, {
        method: "PUT",
        body: JSON.stringify({ content: "modified", attachments: '["file.txt"]' }),
      });

      // Read 2
      res = await req(`/chat/drafts/${sessionId}`);
      data = await res.json() as any;
      expect(data.data.content).toBe("modified");
      expect(data.data.attachments).toBe('["file.txt"]');

      // Delete
      res = await req(`/chat/drafts/${sessionId}`, { method: "DELETE" });
      data = await res.json() as any;
      expect(data.ok).toBe(true);

      // Read 3
      res = await req(`/chat/drafts/${sessionId}`);
      data = await res.json() as any;
      expect(data.data).toBeNull();
    });

    it("concurrent drafts in same project are isolated", async () => {
      const sessionIds = Array.from({ length: 5 }, (_, i) => `concurrent-${i}-${Date.now()}`);

      // Create all drafts
      for (const id of sessionIds) {
        await req(`/chat/drafts/${id}`, {
          method: "PUT",
          body: JSON.stringify({ content: `content-${id}` }),
        });
      }

      // Verify all are retrievable with correct content
      for (const id of sessionIds) {
        const res = await req(`/chat/drafts/${id}`);
        const data = await res.json() as any;
        expect(data.data.content).toBe(`content-${id}`);
      }

      // Delete one and verify others unaffected
      await req(`/chat/drafts/${sessionIds[2]}`, { method: "DELETE" });

      for (const id of sessionIds) {
        const res = await req(`/chat/drafts/${id}`);
        const data = await res.json() as any;
        if (id === sessionIds[2]) {
          expect(data.data).toBeNull();
        } else {
          expect(data.data).not.toBeNull();
        }
      }
    });

    it("multiple updates accumulate content correctly", async () => {
      const sessionId = "test-session-accumulate-" + Date.now();

      // Simulate typing with multiple PUTs
      const updates = [
        "H",
        "He",
        "Hel",
        "Hell",
        "Hello",
        "Hello ",
        "Hello W",
        "Hello Wo",
        "Hello Wor",
        "Hello Worl",
        "Hello World",
      ];

      for (const content of updates) {
        await req(`/chat/drafts/${sessionId}`, {
          method: "PUT",
          body: JSON.stringify({ content }),
        });
      }

      const res = await req(`/chat/drafts/${sessionId}`);
      const data = await res.json() as any;
      expect(data.data.content).toBe("Hello World");
    });
  });

  describe("Edge cases and error handling", () => {
    it("handles sessionId with special characters in URL", async () => {
      // URL-encoded special chars should be handled
      const sessionId = "session-with-dashes-" + Date.now();

      const res = await req(`/chat/drafts/${sessionId}`, {
        method: "PUT",
        body: JSON.stringify({ content: "works" }),
      });
      const json = await res.json() as any;

      expect(json.ok).toBe(true);

      const getRes = await req(`/chat/drafts/${sessionId}`);
      const getData = await getRes.json() as any;
      expect(getData.data.content).toBe("works");
    });

    it("returns 200 with consistent response structure", async () => {
      const sessionId = "test-session-response-" + Date.now();

      // GET missing
      let res = await req(`/chat/drafts/${sessionId}`);
      let data = await res.json() as any;
      expect(data).toHaveProperty("ok");
      expect(data).toHaveProperty("data");

      // PUT
      res = await req(`/chat/drafts/${sessionId}`, {
        method: "PUT",
        body: JSON.stringify({ content: "test" }),
      });
      data = await res.json() as any;
      expect(data).toHaveProperty("ok");
      expect(data).toHaveProperty("data");
      expect(data.data).toHaveProperty("saved");

      // DELETE
      res = await req(`/chat/drafts/${sessionId}`, { method: "DELETE" });
      data = await res.json() as any;
      expect(data).toHaveProperty("ok");
      expect(data).toHaveProperty("data");
      expect(data.data).toHaveProperty("deleted");
    });

    it("GET returns draft with all expected fields", async () => {
      const sessionId = "test-session-fields-" + Date.now();

      await req(`/chat/drafts/${sessionId}`, {
        method: "PUT",
        body: JSON.stringify({
          content: "content",
          attachments: '{"files":[]}',
        }),
      });

      const res = await req(`/chat/drafts/${sessionId}`);
      const data = await res.json() as any;

      expect(data.data).toHaveProperty("content");
      expect(data.data).toHaveProperty("attachments");
      expect(data.data).toHaveProperty("updatedAt");
      expect(typeof data.data.content).toBe("string");
      expect(typeof data.data.attachments).toBe("string");
      expect(typeof data.data.updatedAt).toBe("string");
    });
  });
});
