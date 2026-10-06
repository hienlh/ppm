import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import {
  DESIGN_SKILL_PACKAGE, designSkillsDir, installDesignSkill,
} from "../../../src/services/design/design-skill-install.service.ts";
import { withDesignSkillMention } from "../../../src/shared/design-skill-suggestion.ts";
import { DESIGN_INSTRUCTIONS_MAX_BYTES } from "../../../src/shared/design-skill-mentions.ts";

// A small stand-in for the npm package, shaped like the real one: the real tarball is checked
// against upstream's own installer by tests/e2e/design-skill-install-e2e.ts, which needs the network.
const platform = (root: string) => JSON.stringify({
  folderStructure: { root, skillPath: "skills/ui-ux-pro-max", filename: "SKILL.md" },
  scriptPath: "skills/ui-ux-pro-max/scripts/search.py",
  frontmatter: { name: "ui-ux-pro-max", description: "Design: palettes" },
  sections: { quickReference: true },
  title: "Pro Max",
  description: "Design intelligence.",
  skillOrWorkflow: "Skill",
});

const PACKAGE_FILES: Record<string, string> = {
  "package/package.json": "{}",
  "package/dist/index.js": "console.log('never run')",
  "package/assets/templates/base/skill-content.md": "# {{TITLE}}\n{{DESCRIPTION}}\n{{QUICK_REFERENCE}}\nRun: python3 {{SCRIPT_PATH}} q\nA {{SKILL_OR_WORKFLOW}}.\n",
  // `$&` would be replaced by the match if the template were substituted with a replacement string.
  "package/assets/templates/base/quick-reference.md": "Quick reference, $& kept.",
  "package/assets/templates/platforms/claude.json": platform(".claude"),
  "package/assets/templates/platforms/codex.json": platform(".agents"),
  "package/assets/data/colors.csv": "name,hex\n",
  "package/assets/data/stacks/react.csv": "rule\n",
  "package/assets/scripts/search.py": "print('search')\n",
  "package/assets/skills/brand/SKILL.md": "---\nname: brand\n---\n",
  "package/assets/skills/design/SKILL.md": "---\nname: design\n---\n",
  "package/assets/skills/design/scripts/logo.py": "print('logo')\n",
};

async function tarball(files: Record<string, string>): Promise<Uint8Array> {
  return new Bun.Archive(files, { compress: "gzip" }).bytes();
}

function servePackage(bytes: Uint8Array) {
  let fetches = 0;
  const fetchFn = (async () => {
    fetches++;
    return new Response(bytes);
  }) as unknown as typeof fetch;
  const pkg = { url: "https://registry.example/ui-ux-pro-max-cli.tgz", sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
  return { fetchFn, pkg, fetches: () => fetches };
}

let sandbox: string;
let home: string;
const prevPpmHome = process.env.PPM_HOME;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "ppm-design-skill-"));
  home = join(sandbox, "home");
  mkdirSync(home);
  process.env.PPM_HOME = join(sandbox, "ppm");
  _resetPpmDir();
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  if (prevPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = prevPpmHome;
  _resetPpmDir();
});

describe("installDesignSkill", () => {
  it("writes what upstream's global install writes, for Claude and for Codex", async () => {
    const { fetchFn, pkg } = servePackage(await tarball(PACKAGE_FILES));
    const results = await installDesignSkill(["claude", "codex"], { home, claudeConfigDir: undefined, pkg, fetchFn });

    expect(results.map((r) => [r.runtime, r.installed, r.companions])).toEqual([
      ["claude", true, ["brand", "design"]],
      ["codex", true, ["brand", "design"]],
    ]);
    const claude = join(home, ".claude", "skills");
    const codex = join(home, ".agents", "skills");
    expect(results[0]!.dir).toBe(join(claude, "ui-ux-pro-max"));
    expect(results[1]!.dir).toBe(join(codex, "ui-ux-pro-max"));

    expect(readFileSync(join(claude, "ui-ux-pro-max", "SKILL.md"), "utf8")).toBe(
      '---\nname: ui-ux-pro-max\ndescription: "Design: palettes"\n---\n' +
      "# Pro Max\nDesign intelligence.\n\nQuick reference, $& kept.\n" +
      "Run: python3 ~/.claude/skills/ui-ux-pro-max/scripts/search.py q\nA Skill.\n",
    );
    expect(readFileSync(join(codex, "ui-ux-pro-max", "SKILL.md"), "utf8"))
      .toContain("Run: python3 ~/.agents/skills/ui-ux-pro-max/scripts/search.py q");
    for (const skills of [claude, codex]) {
      expect(readFileSync(join(skills, "ui-ux-pro-max", "data", "stacks", "react.csv"), "utf8")).toBe("rule\n");
      expect(readFileSync(join(skills, "ui-ux-pro-max", "scripts", "search.py"), "utf8")).toBe("print('search')\n");
      expect(readFileSync(join(skills, "design", "scripts", "logo.py"), "utf8")).toBe("print('logo')\n");
      expect(readdirSync(skills).sort()).toEqual(["brand", "design", "ui-ux-pro-max"]);
    }
    // Nothing of the package outside `assets/` lands anywhere, and the staging folder is gone.
    expect(readdirSync(join(sandbox, "ppm", "design-skill"))).toEqual([]);
  });

  it("follows CLAUDE_CONFIG_DIR, writing the script path where the skill really is", async () => {
    const { fetchFn, pkg } = servePackage(await tarball(PACKAGE_FILES));
    const outside = join(sandbox, "claude-config");
    const [result] = await installDesignSkill(["claude"], { home, claudeConfigDir: outside, pkg, fetchFn });

    expect(result!.dir).toBe(join(outside, "skills", "ui-ux-pro-max"));
    expect(readFileSync(join(result!.dir, "SKILL.md"), "utf8"))
      .toContain(`Run: python3 ${join(outside, "skills", "ui-ux-pro-max", "scripts", "search.py")} q`);
    expect(existsSync(join(home, ".claude"))).toBe(false);
    // Under the home folder it is written the way upstream writes it.
    expect(designSkillsDir("claude", home, join(home, ".config", "claude"))).toBe(join(home, ".config", "claude", "skills"));
  });

  it("replaces nothing: an installed skill and a taken companion name are left as they were", async () => {
    const { fetchFn, pkg } = servePackage(await tarball(PACKAGE_FILES));
    const claude = join(home, ".claude", "skills");
    mkdirSync(join(claude, "ui-ux-pro-max"), { recursive: true });
    writeFileSync(join(claude, "ui-ux-pro-max", "SKILL.md"), "mine");
    mkdirSync(join(home, ".agents", "skills", "design"), { recursive: true });
    writeFileSync(join(home, ".agents", "skills", "design", "SKILL.md"), "also mine");

    const results = await installDesignSkill(["claude", "codex"], { home, claudeConfigDir: undefined, pkg, fetchFn });
    expect(results.map((r) => [r.runtime, r.installed, r.companions])).toEqual([
      ["claude", false, []],
      ["codex", true, ["brand"]],
    ]);
    expect(readFileSync(join(claude, "ui-ux-pro-max", "SKILL.md"), "utf8")).toBe("mine");
    expect(readdirSync(claude)).toEqual(["ui-ux-pro-max"]);
    expect(readFileSync(join(home, ".agents", "skills", "design", "SKILL.md"), "utf8")).toBe("also mine");
  });

  it("writes nothing when the download does not match the pinned hash", async () => {
    const { fetchFn, pkg } = servePackage(await tarball(PACKAGE_FILES));
    const wrong = { ...pkg, sha256: "0".repeat(64) };
    await expect(installDesignSkill(["claude"], { home, claudeConfigDir: undefined, pkg: wrong, fetchFn }))
      .rejects.toThrow(/checksum mismatch/);
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(readdirSync(join(sandbox, "ppm", "design-skill"))).toEqual([]);
  });

  it("refuses an archive entry that would land outside its folder", async () => {
    for (const name of ["package/assets/../evil.txt", "package/assets/data/a\\b.csv", "package/assets/data//x.csv"]) {
      const { fetchFn, pkg } = servePackage(await tarball({ ...PACKAGE_FILES, [name]: "x" }));
      await expect(installDesignSkill(["claude"], { home, claudeConfigDir: undefined, pkg, fetchFn }))
        .rejects.toThrow(/Unexpected path/);
      expect(existsSync(join(home, ".claude"))).toBe(false);
    }
  });

  it("refuses a template this install was not written for", async () => {
    const moved = JSON.parse(platform(".claude"));
    moved.folderStructure.dataPath = "data/ui-ux-pro-max";
    const { fetchFn, pkg } = servePackage(await tarball({
      ...PACKAGE_FILES, "package/assets/templates/platforms/claude.json": JSON.stringify(moved),
    }));
    await expect(installDesignSkill(["claude"], { home, claudeConfigDir: undefined, pkg, fetchFn }))
      .rejects.toThrow(/unexpected claude.json/);
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  it("lets a second click join the install that is running", async () => {
    const served = servePackage(await tarball(PACKAGE_FILES));
    const options = { home, claudeConfigDir: undefined, pkg: served.pkg, fetchFn: served.fetchFn };
    const [a, b] = await Promise.all([installDesignSkill(["claude"], options), installDesignSkill(["claude"], options)]);
    expect(a).toBe(b);
    expect(served.fetches()).toBe(1);
  });

  it("pins the real package by version and hash", () => {
    expect(DESIGN_SKILL_PACKAGE.url).toBe(
      `https://registry.npmjs.org/ui-ux-pro-max-cli/-/ui-ux-pro-max-cli-${DESIGN_SKILL_PACKAGE.version}.tgz`,
    );
    expect(DESIGN_SKILL_PACKAGE.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("withDesignSkillMention", () => {
  it("adds one line naming the skill, after whatever is there", () => {
    expect(withDesignSkillMention("")).toBe("Use /ui-ux-pro-max before designing.");
    expect(withDesignSkillMention("Keep it calm.\n")).toBe("Keep it calm.\nUse /ui-ux-pro-max before designing.");
  });

  it("leaves text that already names it, under either sigil or a namespace", () => {
    for (const text of ["Use /ui-ux-pro-max", "Use $ui-ux-pro-max first", "Try /ak:ui-ux-pro-max."]) {
      expect(withDesignSkillMention(text)).toBe(text);
    }
  });

  it("answers null when the line would not fit", () => {
    expect(withDesignSkillMention("x".repeat(DESIGN_INSTRUCTIONS_MAX_BYTES - 10))).toBeNull();
  });
});
