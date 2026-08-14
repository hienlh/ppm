import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { resolveInstalledPlugins } from "../../src/services/slash-discovery/discover-skill-roots";
import { loadDisabledPluginKeys } from "../../src/services/slash-discovery/plugin-enablement";

let root: string;

/** Create a plugin directory carrying a manifest, and return its path. */
function makePlugin(pluginsDir: string, name: string): string {
  const dir = join(pluginsDir, name);
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
  return dir;
}

function writeRegistry(pluginsDir: string, plugins: Record<string, Array<{ installPath?: string }>>): void {
  writeFileSync(
    join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins }),
  );
}

function writeSettings(dir: string, fileName: string, enabledPlugins: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), JSON.stringify({ enabledPlugins }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-slash-plugins-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveInstalledPlugins", () => {
  it("returns registry entries keyed by plugin-id@marketplace-id", () => {
    const pluginsDir = join(root, "plugins");
    const enginePath = makePlugin(pluginsDir, "cache-ak-engineer");
    const marketPath = makePlugin(pluginsDir, "cache-ak-marketing");
    writeRegistry(pluginsDir, {
      "ak-engineer@agentkit-local": [{ installPath: enginePath }],
      "ak-marketing@agentkit-local": [{ installPath: marketPath }],
    });

    const result = resolveInstalledPlugins(pluginsDir);

    expect(result).toHaveLength(2);
    expect(result.map((p) => p.key).sort()).toEqual([
      "ak-engineer@agentkit-local",
      "ak-marketing@agentkit-local",
    ]);
    expect(result.map((p) => resolve(p.path)).sort()).toEqual(
      [resolve(enginePath), resolve(marketPath)].sort(),
    );
  });

  it("skips registry entries whose installPath no longer exists", () => {
    const pluginsDir = join(root, "plugins");
    const livePath = makePlugin(pluginsDir, "live");
    writeRegistry(pluginsDir, {
      "live@mkt": [{ installPath: livePath }],
      "stale@mkt": [{ installPath: join(pluginsDir, "does-not-exist") }],
    });

    const result = resolveInstalledPlugins(pluginsDir);

    expect(result).toHaveLength(1);
    expect(result[0]!.key).toBe("live@mkt");
  });

  it("falls back to scanning manifest directories when the registry is malformed", () => {
    const pluginsDir = join(root, "plugins");
    const pluginPath = makePlugin(pluginsDir, "scanned");
    mkdirSync(join(pluginsDir, "cache"), { recursive: true }); // no manifest — must be ignored
    writeFileSync(join(pluginsDir, "installed_plugins.json"), "{ not json");

    const result = resolveInstalledPlugins(pluginsDir);

    expect(result).toHaveLength(1);
    expect(resolve(result[0]!.path)).toBe(resolve(pluginPath));
    expect(result[0]!.key).toBeUndefined();
  });

  it("falls back to scanning when the registry lists nothing usable", () => {
    const pluginsDir = join(root, "plugins");
    const pluginPath = makePlugin(pluginsDir, "scanned");
    writeRegistry(pluginsDir, {});

    const result = resolveInstalledPlugins(pluginsDir);

    expect(result.map((p) => resolve(p.path))).toEqual([resolve(pluginPath)]);
  });

  it("returns nothing for a missing plugins directory", () => {
    expect(resolveInstalledPlugins(join(root, "absent"))).toEqual([]);
  });
});

describe("loadDisabledPluginKeys", () => {
  it("treats a plugin absent from settings as enabled", () => {
    expect(loadDisabledPluginKeys(root).has("ak-engineer@agentkit-local")).toBe(false);
  });

  it("collects only keys explicitly set to false", () => {
    writeSettings(join(root, ".claude"), "settings.json", {
      "on@mkt": true,
      "off@mkt": false,
      "versioned@mkt": ["1.0.0"],
    });

    const disabled = loadDisabledPluginKeys(root);

    expect(disabled.has("off@mkt")).toBe(true);
    expect(disabled.has("on@mkt")).toBe(false);
    expect(disabled.has("versioned@mkt")).toBe(false);
  });

  it("lets settings.local.json override project settings", () => {
    writeSettings(join(root, ".claude"), "settings.json", { "plugin@mkt": true });
    writeSettings(join(root, ".claude"), "settings.local.json", { "plugin@mkt": false });

    expect(loadDisabledPluginKeys(root).has("plugin@mkt")).toBe(true);
  });

  it("lets project settings re-enable a plugin", () => {
    writeSettings(join(root, ".claude"), "settings.json", { "plugin@mkt": true });
    writeSettings(join(root, ".claude"), "settings.local.json", { "other@mkt": false });

    const disabled = loadDisabledPluginKeys(root);

    expect(disabled.has("plugin@mkt")).toBe(false);
    expect(disabled.has("other@mkt")).toBe(true);
  });

  it("ignores unreadable settings files", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), "{ not json");
    writeSettings(join(root, ".claude"), "settings.local.json", { "off@mkt": false });

    const disabled = loadDisabledPluginKeys(root);

    expect(disabled.has("off@mkt")).toBe(true);
  });
});
