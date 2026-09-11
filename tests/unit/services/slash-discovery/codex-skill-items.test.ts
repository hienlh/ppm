import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codexSkillsToSlashItems } from "../../../../src/services/slash-discovery/codex-skill-items.ts";
import type { CodexSkill } from "../../../../src/providers/codex-app-server/codex-protocol.ts";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>';
let dir: string;
let iconPath: string;
let bigIconPath: string;
let unknownTypePath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-skill-items-"));
  iconPath = join(dir, "imagegen-small.svg");
  writeFileSync(iconPath, SVG);
  bigIconPath = join(dir, "huge.svg");
  writeFileSync(bigIconPath, "x".repeat(33 * 1024));
  unknownTypePath = join(dir, "icon.bmp");
  writeFileSync(unknownTypePath, "not inlined");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const skill = (over: Partial<CodexSkill> = {}): CodexSkill => ({
  name: "imagegen",
  description: "Generate or edit raster images…",
  scope: "system",
  enabled: true,
  ...over,
});

describe("codexSkillsToSlashItems", () => {
  it("marks every item with the $ sigil codex needs", () => {
    const [item] = codexSkillsToSlashItems([skill()]);
    expect(item!.invokeSigil).toBe("$");
    expect(item!.name).toBe("imagegen");
    expect(item!.type).toBe("skill");
  });

  it("prefers the interface's short description over the long one", () => {
    const [item] = codexSkillsToSlashItems([skill({
      interface: { shortDescription: "Generate or edit images", displayName: "Image Gen" },
    })]);
    expect(item!.description).toBe("Generate or edit images");
    expect(item!.displayName).toBe("Image Gen");
  });

  it("falls back to the long description, then to empty", () => {
    expect(codexSkillsToSlashItems([skill()])[0]!.description).toBe("Generate or edit raster images…");
    expect(codexSkillsToSlashItems([skill({ description: undefined })])[0]!.description).toBe("");
  });

  it("maps system scope to bundled and anything else to user", () => {
    expect(codexSkillsToSlashItems([skill({ scope: "system" })])[0]!.scope).toBe("bundled");
    expect(codexSkillsToSlashItems([skill({ scope: "project" })])[0]!.scope).toBe("user");
    expect(codexSkillsToSlashItems([skill({ scope: undefined })])[0]!.scope).toBe("user");
  });

  it("inlines the icon as a data URI", () => {
    const [item] = codexSkillsToSlashItems([skill({ interface: { iconSmall: iconPath } })]);
    expect(item!.iconDataUri).toBe(`data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}`);
  });

  it("has no icon when the path is missing, unreadable, oversized, or an unknown type", () => {
    const cases = [
      undefined,
      join(dir, "does-not-exist.svg"),
      bigIconPath,
      unknownTypePath,
    ];
    for (const iconSmall of cases) {
      const [item] = codexSkillsToSlashItems([skill({ interface: { iconSmall } })]);
      expect(item!.iconDataUri).toBeUndefined();
      // A broken icon must never cost the skill its place in the picker.
      expect(item!.name).toBe("imagegen");
    }
  });

  it("returns [] for an empty list", () => {
    expect(codexSkillsToSlashItems([])).toEqual([]);
  });
});
