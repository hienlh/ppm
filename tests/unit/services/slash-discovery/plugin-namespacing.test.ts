import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadItemsFromRoot } from "../../../../src/services/slash-discovery/skill-loader";
import { resolvePluginName } from "../../../../src/services/slash-discovery/discover-skill-roots";
import type { SkillRoot } from "../../../../src/services/slash-discovery/types";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-slash-ns-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a markdown file with the given frontmatter lines plus a body. */
function writeMd(path: string, frontmatter: string[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `---\n${frontmatter.join("\n")}\n---\n\nbody\n`);
}

function pluginRoot(origin: SkillRoot["origin"], pluginName?: string): SkillRoot {
  return { path: join(root, origin), source: "user-plugin", origin, ...(pluginName && { pluginName }) };
}

describe("plugin item namespacing", () => {
  it("names a plugin skill after its directory, keeping the declared name as an alias", () => {
    writeMd(join(root, "skills", "ak-debug", "SKILL.md"), ["name: ak:debug", "description: Debug"]);

    const [item] = loadItemsFromRoot(pluginRoot("skills", "ak-engineer"));

    expect(item?.name).toBe("ak-engineer:ak-debug");
    expect(item?.aliases).toEqual(["ak:debug"]);
    expect(item?.description).toBe("Debug");
  });

  it("namespaces a nested plugin skill by its full relative path", () => {
    writeMd(join(root, "skills", "group", "nested", "SKILL.md"), ["description: Nested"]);

    const [item] = loadItemsFromRoot(pluginRoot("skills", "kit"));

    expect(item?.name).toBe("kit:group/nested");
    expect(item?.aliases).toBeUndefined();
  });

  it("namespaces plugin commands by path too", () => {
    writeMd(join(root, "commands", "deploy.md"), ["name: ak:deploy", "description: Deploy"]);

    const [item] = loadItemsFromRoot(pluginRoot("commands", "ak-engineer"));

    expect(item?.name).toBe("ak-engineer:deploy");
    expect(item?.aliases).toEqual(["ak:deploy"]);
  });

  it("names a plugin agent after its frontmatter name, not its filename", () => {
    writeMd(join(root, "agents", "explore.md"), ["name: Explore", "description: Scan"]);

    const [item] = loadItemsFromRoot(pluginRoot("agents", "ak-engineer"));

    expect(item?.name).toBe("ak-engineer:Explore");
    expect(item?.aliases).toBeUndefined();
  });

  it("falls back to the filename for an agent that declares no name", () => {
    writeMd(join(root, "agents", "tester.md"), ["description: Tests"]);

    const [item] = loadItemsFromRoot(pluginRoot("agents", "ak-engineer"));

    expect(item?.name).toBe("ak-engineer:tester");
  });

  it("emits no alias when the declared name already matches the qualified one", () => {
    writeMd(join(root, "skills", "ak-debug", "SKILL.md"), ["name: ak-engineer:ak-debug", "description: D"]);

    const [item] = loadItemsFromRoot(pluginRoot("skills", "ak-engineer"));

    expect(item?.name).toBe("ak-engineer:ak-debug");
    expect(item?.aliases).toBeUndefined();
  });

  it("leaves non-plugin roots on their declared name", () => {
    writeMd(join(root, "skills", "my-skill", "SKILL.md"), ["name: custom", "description: Mine"]);

    const [item] = loadItemsFromRoot({ path: join(root, "skills"), source: "user-claude", origin: "skills" });

    expect(item?.name).toBe("custom");
    expect(item?.aliases).toBeUndefined();
  });
});

describe("resolvePluginName", () => {
  it("takes the plugin id from the registry key", () => {
    expect(resolvePluginName({ key: "ak-engineer@agentkit-local", path: root })).toBe("ak-engineer");
  });

  it("reads the manifest when there is no registry key", () => {
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "from-manifest" }));

    expect(resolvePluginName({ path: root })).toBe("from-manifest");
  });

  it("falls back to the directory name when the manifest is unusable", () => {
    expect(resolvePluginName({ path: join(root, "some-plugin") })).toBe("some-plugin");
  });
});
