import { describe, test, expect } from "bun:test";
import { providerRegistry } from "../../src/providers/registry.ts";

describe("ProviderRegistry", () => {
  describe("list() — user-facing providers", () => {
    test("excludes mock provider", () => {
      const providers = providerRegistry.list();
      const ids = providers.map((p) => p.id);
      expect(ids).not.toContain("mock");
    });

    test("includes claude provider", () => {
      const providers = providerRegistry.list();
      const ids = providers.map((p) => p.id);
      expect(ids).toContain("claude");
    });

    test("returns objects with id and name", () => {
      const providers = providerRegistry.list();
      for (const p of providers) {
        expect(typeof p.id).toBe("string");
        expect(typeof p.name).toBe("string");
        expect(p.id.length).toBeGreaterThan(0);
        expect(p.name.length).toBeGreaterThan(0);
      }
    });
  });

  describe("listAll() — includes internal providers", () => {
    test("includes mock provider", () => {
      const providers = providerRegistry.listAll();
      const ids = providers.map((p) => p.id);
      expect(ids).toContain("mock");
    });

    test("includes claude provider", () => {
      const providers = providerRegistry.listAll();
      const ids = providers.map((p) => p.id);
      expect(ids).toContain("claude");
    });

    test("listAll has more or equal entries than list", () => {
      const all = providerRegistry.listAll();
      const visible = providerRegistry.list();
      expect(all.length).toBeGreaterThanOrEqual(visible.length);
    });
  });

  describe("get()", () => {
    test("returns claude provider", () => {
      const provider = providerRegistry.get("claude");
      expect(provider).toBeDefined();
      expect(provider?.id).toBe("claude");
    });

    test("returns mock provider", () => {
      const provider = providerRegistry.get("mock");
      expect(provider).toBeDefined();
      expect(provider?.id).toBe("mock");
      expect(provider?.name).toBe("Mock AI (Dev)");
    });

    test("returns undefined for unknown provider", () => {
      const provider = providerRegistry.get("nonexistent");
      expect(provider).toBeUndefined();
    });
  });

  describe("getDefault()", () => {
    test("returns a valid provider", () => {
      const provider = providerRegistry.getDefault();
      expect(provider).toBeDefined();
      expect(provider.id).toBeTruthy();
      expect(provider.name).toBeTruthy();
    });

    test("default provider has required methods", () => {
      const provider = providerRegistry.getDefault();
      expect(typeof provider.createSession).toBe("function");
      expect(typeof provider.resumeSession).toBe("function");
      expect(typeof provider.listSessions).toBe("function");
      expect(typeof provider.deleteSession).toBe("function");
      expect(typeof provider.sendMessage).toBe("function");
    });
  });

  describe("provider capabilities", () => {
    test("claude provider has optional methods", () => {
      const claude = providerRegistry.get("claude");
      expect(claude).toBeDefined();
      // Claude SDK provider should have these capabilities
      expect(typeof claude?.abortQuery).toBe("function");
      expect(typeof claude?.getMessages).toBe("function");
      expect(typeof claude?.listModels).toBe("function");
    });

    test("mock provider implements required interface", () => {
      const mock = providerRegistry.get("mock");
      expect(mock).toBeDefined();
      expect(typeof mock?.createSession).toBe("function");
      expect(typeof mock?.resumeSession).toBe("function");
      expect(typeof mock?.listSessions).toBe("function");
      expect(typeof mock?.deleteSession).toBe("function");
      expect(typeof mock?.sendMessage).toBe("function");
    });
  });
});
