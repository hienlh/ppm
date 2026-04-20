import { describe, it, expect, beforeAll } from "bun:test";
import "../../test-setup.ts"; // disable auth
import { configService } from "../../../src/services/config.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { app } from "../../../src/server/index.ts";

// Ensure clean state: test DB + auth disabled + test project registered
beforeAll(() => {
  const { setDb, openTestDb } = require("../../../src/services/db.service.ts");
  setDb(openTestDb());
  (configService as any).config.auth = { enabled: false, token: "" };
  const projects = configService.get("projects");
  if (!projects.find((p) => p.name === "test")) {
    projects.push({ name: "test", path: process.cwd() });
    configService.set("projects", projects);
  }
});

const PROJECT = "test";

async function reqSettings(path: string, init?: RequestInit) {
  const url = `http://localhost/api/settings${path}`;
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  return app.request(new Request(url, { ...init, headers }));
}

async function reqProject(path: string, init?: RequestInit) {
  const url = `http://localhost/api/project/${PROJECT}${path}`;
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  return app.request(new Request(url, { ...init, headers }));
}

describe("Provider Models API", () => {
  describe("Settings endpoint: GET /api/settings/ai/providers/:id/models", () => {
    it("returns models for Claude provider", async () => {
      const res = await reqSettings("/ai/providers/claude/models");
      expect(res.status).toBe(200);

      const json = (await res.json()) as any;
      expect(json.ok).toBe(true);
      expect(Array.isArray(json.data)).toBe(true);
      expect(json.data.length).toBe(4);

      const values = json.data.map((m: any) => m.value);
      expect(values).toContain("claude-sonnet-4-6");
      expect(values).toContain("claude-opus-4-7");
      expect(values).toContain("claude-opus-4-6");
      expect(values).toContain("claude-haiku-4-5");

      // Check labels
      const sonnetModel = json.data.find((m: any) => m.value === "claude-sonnet-4-6");
      expect(sonnetModel.label).toBe("Claude Sonnet 4.6");

      const opus47Model = json.data.find((m: any) => m.value === "claude-opus-4-7");
      expect(opus47Model.label).toBe("Claude Opus 4.7");

      const opusModel = json.data.find((m: any) => m.value === "claude-opus-4-6");
      expect(opusModel.label).toBe("Claude Opus 4.6");

      const haikuModel = json.data.find((m: any) => m.value === "claude-haiku-4-5");
      expect(haikuModel.label).toBe("Claude Haiku 4.5");
    });

    it("returns 404 for unknown provider", async () => {
      const res = await reqSettings("/ai/providers/unknown/models");
      expect(res.status).toBe(404);

      const json = (await res.json()) as any;
      expect(json.ok).toBe(false);
      expect(json.error).toContain('Provider "unknown" not found');
    });

    it("returns empty array for provider without listModels (mock provider)", async () => {
      const res = await reqSettings("/ai/providers/mock/models");
      expect(res.status).toBe(200);

      const json = (await res.json()) as any;
      expect(json.ok).toBe(true);
      expect(Array.isArray(json.data)).toBe(true);
      expect(json.data.length).toBe(0);
    });

    it("handles errors gracefully", async () => {
      // Try to access a provider that doesn't exist
      const res = await reqSettings("/ai/providers/nonexistent/models");
      expect(res.status).toBe(404);
      const json = (await res.json()) as any;
      expect(json.ok).toBe(false);
    });
  });

  describe("Project-scoped endpoint: GET /api/project/:name/chat/providers/:providerId/models", () => {
    it("returns models for Claude provider in project context", async () => {
      const res = await reqProject("/chat/providers/claude/models");
      expect(res.status).toBe(200);

      const json = (await res.json()) as any;
      expect(json.ok).toBe(true);
      expect(Array.isArray(json.data)).toBe(true);
      expect(json.data.length).toBe(4);

      const values = json.data.map((m: any) => m.value);
      expect(values).toContain("claude-sonnet-4-6");
      expect(values).toContain("claude-opus-4-7");
      expect(values).toContain("claude-opus-4-6");
      expect(values).toContain("claude-haiku-4-5");
    });

    it("returns empty array for mock provider in project context", async () => {
      const res = await reqProject("/chat/providers/mock/models");
      expect(res.status).toBe(200);

      const json = (await res.json()) as any;
      expect(json.ok).toBe(true);
      expect(Array.isArray(json.data)).toBe(true);
      expect(json.data.length).toBe(0);
    });

    it("returns 404 for unknown provider in project context", async () => {
      const res = await reqProject("/chat/providers/unknown/models");
      expect(res.status).toBe(404);

      const json = (await res.json()) as any;
      expect(json.ok).toBe(false);
      expect(json.error).toContain('Provider "unknown" not found');
    });
  });

  describe("Provider visibility in registry", () => {
    it("GET /api/project/:name/chat/providers does not include mock provider", async () => {
      const res = await reqProject("/chat/providers");
      expect(res.status).toBe(200);

      const json = (await res.json()) as any;
      expect(json.ok).toBe(true);
      expect(Array.isArray(json.data)).toBe(true);

      const providerIds = json.data.map((p: any) => p.id);
      expect(providerIds).not.toContain("mock");
      // Claude provider should be there
      expect(providerIds).toContain("claude");
    });

    it("providerRegistry.list() filters out mock provider", () => {
      const providers = providerRegistry.list();
      const ids = providers.map((p) => p.id);

      expect(ids).not.toContain("mock");
      expect(ids).toContain("claude");
    });

    it("providerRegistry.listAll() includes mock provider", () => {
      const providers = providerRegistry.listAll();
      const ids = providers.map((p) => p.id);

      expect(ids).toContain("mock");
      expect(ids).toContain("claude");
    });

    it("mock provider is accessible via providerRegistry.get()", () => {
      const mockProvider = providerRegistry.get("mock");
      expect(mockProvider).toBeDefined();
      expect(mockProvider?.id).toBe("mock");
      expect(mockProvider?.name).toBe("Mock AI (Dev)");
    });
  });

  describe("Model endpoint response format", () => {
    it("models have required fields: value and label", async () => {
      const res = await reqSettings("/ai/providers/claude/models");
      const json = (await res.json()) as any;

      expect(json.data.length).toBeGreaterThan(0);
      for (const model of json.data) {
        expect(model).toHaveProperty("value");
        expect(model).toHaveProperty("label");
        expect(typeof model.value).toBe("string");
        expect(typeof model.label).toBe("string");
        expect(model.value.length).toBeGreaterThan(0);
        expect(model.label.length).toBeGreaterThan(0);
      }
    });

    it("settings and project endpoints return consistent data", async () => {
      const settingsRes = await reqSettings("/ai/providers/claude/models");
      const projectRes = await reqProject("/chat/providers/claude/models");

      const settingsJson = (await settingsRes.json()) as any;
      const projectJson = (await projectRes.json()) as any;

      expect(settingsJson.data).toEqual(projectJson.data);
    });
  });
});
