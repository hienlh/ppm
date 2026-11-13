import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Never the real ~/.ppm: the local embedder resolves its install dir under PPM_HOME.
process.env.PPM_HOME = mkdtempSync(join(tmpdir(), "ppm-memory-settings-"));

const { memoryEnabled, currentEmbedder, publicMemorySettings } = await import("../../../src/services/memory/memory-settings.ts");
const { ApiEmbedder } = await import("../../../src/services/memory/embedding/api-embedder.ts");
const { LocalEmbedder } = await import("../../../src/services/memory/embedding/local-embedder.ts");
const { MEMORY_TOOLS } = await import("../../../src/shared/memory-tools.ts");
const { isSecretConfigKey, redactSecretConfigValue } = await import("../../../src/services/config-secret-keys.ts");

type Ai = Parameters<typeof memoryEnabled>[0];

const allMemoryTools = (on: boolean) => Object.fromEntries(MEMORY_TOOLS.map((t) => [t, on]));

describe("memoryEnabled", () => {
  test("follows the memory tools when enabled is unset: off while the feature is undecided", () => {
    expect(memoryEnabled({ share_provider_context: true } as Ai)).toBe(false);
  });

  test("follows the memory tools when enabled is unset: on once any memory tool is on", () => {
    expect(memoryEnabled({ share_provider_context: true, ppm_tools: allMemoryTools(true) } as Ai)).toBe(true);
    expect(memoryEnabled({ share_provider_context: true, ppm_tools: { memory_search: true } } as Ai)).toBe(true);
    expect(memoryEnabled({ share_provider_context: true, ppm_tools: allMemoryTools(false) } as Ai)).toBe(false);
  });

  test("an explicit enabled wins over the tool switches", () => {
    expect(memoryEnabled({ share_provider_context: true, ppm_tools: allMemoryTools(false), memory: { enabled: true } } as Ai)).toBe(true);
    expect(memoryEnabled({ share_provider_context: true, ppm_tools: allMemoryTools(true), memory: { enabled: false } } as Ai)).toBe(false);
  });

  test("is always off when the shared provider context is off", () => {
    expect(memoryEnabled({ share_provider_context: false, memory: { enabled: true } } as Ai)).toBe(false);
    expect(memoryEnabled({ share_provider_context: false, ppm_tools: allMemoryTools(true) } as Ai)).toBe(false);
  });

  test("an unset share_provider_context counts as on", () => {
    expect(memoryEnabled({ memory: { enabled: true } } as Ai)).toBe(true);
  });
});

describe("currentEmbedder", () => {
  test("is null with no memory settings, no embedding settings, or source off", () => {
    expect(currentEmbedder({} as Ai)).toBeNull();
    expect(currentEmbedder({ memory: {} } as Ai)).toBeNull();
    expect(currentEmbedder({ memory: { embedding: { source: "off" } } } as Ai)).toBeNull();
  });

  test("is null for an API source missing its URL or model", () => {
    expect(currentEmbedder({ memory: { embedding: { source: "api", api_model: "m" } } } as Ai)).toBeNull();
    expect(currentEmbedder({ memory: { embedding: { source: "api", api_url: "http://x/v1" } } } as Ai)).toBeNull();
  });

  test("builds the API embedder named after its URL and model", () => {
    const e = currentEmbedder({
      memory: { embedding: { source: "api", api_url: "http://127.0.0.1:9/v1", api_model: "text-embed", api_key: "k1" } },
    } as Ai);
    expect(e).toBeInstanceOf(ApiEmbedder);
    expect(e!.model).toBe("api:http://127.0.0.1:9/v1#text-embed");
  });

  test("builds the local embedder", () => {
    const e = currentEmbedder({ memory: { embedding: { source: "local" } } } as Ai);
    expect(e).toBeInstanceOf(LocalEmbedder);
    expect(e!.model.startsWith("local:")).toBe(true);
  });

  test("the same settings give the same embedder", () => {
    const api = { memory: { embedding: { source: "api", api_url: "http://a/v1", api_model: "m", api_key: "k" } } } as Ai;
    const apiCopy = { memory: { embedding: { source: "api", api_url: "http://a/v1", api_model: "m", api_key: "k" } } } as Ai;
    expect(currentEmbedder(api)).toBe(currentEmbedder(apiCopy));
    const local = { memory: { embedding: { source: "local" } } } as Ai;
    expect(currentEmbedder(local)).toBe(currentEmbedder({ memory: { embedding: { source: "local" } } } as Ai));
  });

  test("a settings change gives a new embedder", () => {
    const base = { source: "api", api_url: "http://a/v1", api_model: "m", api_key: "k" };
    const first = currentEmbedder({ memory: { embedding: base } } as Ai);
    const otherKey = currentEmbedder({ memory: { embedding: { ...base, api_key: "k2" } } } as Ai);
    const otherModel = currentEmbedder({ memory: { embedding: { ...base, api_model: "m2" } } } as Ai);
    const otherUrl = currentEmbedder({ memory: { embedding: { ...base, api_url: "http://b/v1" } } } as Ai);
    expect(otherKey).not.toBe(first);
    expect(otherModel).not.toBe(first);
    expect(otherUrl).not.toBe(first);
    expect(otherModel!.model).toBe("api:http://a/v1#m2");
    const local = currentEmbedder({ memory: { embedding: { source: "local" } } } as Ai);
    expect(local).not.toBe(first);
    expect(local).toBeInstanceOf(LocalEmbedder);
  });
});

describe("publicMemorySettings", () => {
  test("says a key is set and never carries it", () => {
    const ai = {
      share_provider_context: true,
      memory: { enabled: true, embedding: { source: "api", api_url: "http://a/v1", api_model: "m", api_key: "sk-secret-123" } },
    } as Ai;
    const out = publicMemorySettings(ai);
    expect(out.embedding.has_api_key).toBe(true);
    expect(out.embedding.source).toBe("api");
    expect(out.embedding.api_url).toBe("http://a/v1");
    expect(out.embedding.api_model).toBe("m");
    expect("api_key" in out.embedding).toBe(false);
    expect(JSON.stringify(out)).not.toContain("sk-secret-123");
  });

  test("has_api_key is false with no key, and the source defaults to off", () => {
    expect(publicMemorySettings({} as Ai).embedding).toEqual({ source: "off", has_api_key: false });
    expect(publicMemorySettings({ memory: { embedding: { source: "api", api_key: "" } } } as Ai).embedding.has_api_key).toBe(false);
  });

  test("reports whether memory is on, as memoryEnabled resolves it", () => {
    expect(publicMemorySettings({ share_provider_context: true, memory: { enabled: true } } as Ai).enabled).toBe(true);
    expect(publicMemorySettings({ share_provider_context: false, memory: { enabled: true } } as Ai).enabled).toBe(false);
    expect(publicMemorySettings({ share_provider_context: true, ppm_tools: allMemoryTools(true) } as Ai).enabled).toBe(true);
  });
});

describe("the embedding API key is a secret config key", () => {
  test("isSecretConfigKey knows it", () => {
    expect(isSecretConfigKey("ai.memory.embedding.api_key")).toBe(true);
    expect(isSecretConfigKey("ai.memory.embedding.api_url")).toBe(false);
  });

  test("an ai dump masks it and keeps its siblings", () => {
    const out = redactSecretConfigValue("ai", {
      share_provider_context: true,
      memory: { enabled: true, embedding: { source: "api", api_url: "http://a/v1", api_model: "m", api_key: "sk-secret-123" } },
    }) as { memory: { embedding: Record<string, unknown> } };
    expect(out.memory.embedding.api_key).not.toBe("sk-secret-123");
    expect(JSON.stringify(out)).not.toContain("sk-secret-123");
    expect(out.memory.embedding.api_url).toBe("http://a/v1");
    expect(out.memory.embedding.source).toBe("api");
  });

  test("a whole-config dump masks it too", () => {
    const out = redactSecretConfigValue("", { ai: { memory: { embedding: { api_key: "sk-secret-123" } } } });
    expect(JSON.stringify(out)).not.toContain("sk-secret-123");
  });
});
