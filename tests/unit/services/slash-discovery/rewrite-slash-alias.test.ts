import { describe, it, expect } from "bun:test";
import { rewriteSlashAlias } from "../../../../src/services/slash-discovery/rewrite-slash-alias";
import type { SlashItem } from "../../../../src/services/slash-discovery/types";

function skill(name: string, aliases?: string[]): SlashItem {
  return { type: "skill", name, description: "", scope: "user", ...(aliases && { aliases }) };
}

const items: SlashItem[] = [
  skill("ak-engineer:ak-debug", ["ak:debug"]),
  skill("ak-engineer:ak-cook", ["ak:cook"]),
  skill("ak-marketing:ak-cook", ["ak:cook"]),
  skill("ak-marketing:ak-seo", ["ak:seo"]),
  skill("game-assets"),
];

describe("rewriteSlashAlias", () => {
  it("rewrites a legacy self-namespaced alias to the plugin-qualified name", () => {
    expect(rewriteSlashAlias("/ak:debug", items)).toBe("/ak-engineer:ak-debug");
  });

  it("preserves the arguments that follow the command", () => {
    expect(rewriteSlashAlias("/ak:debug why does login 500?", items)).toBe(
      "/ak-engineer:ak-debug why does login 500?",
    );
  });

  it("preserves a multi-line body", () => {
    expect(rewriteSlashAlias("/ak:seo\naudit the pricing page", items)).toBe(
      "/ak-marketing:ak-seo\naudit the pricing page",
    );
  });

  it("resolves an alias owned by a non-first plugin", () => {
    expect(rewriteSlashAlias("/ak:seo", items)).toBe("/ak-marketing:ak-seo");
  });

  it("picks the first match in discovery order when kits share an alias", () => {
    expect(rewriteSlashAlias("/ak:cook", items)).toBe("/ak-engineer:ak-cook");
  });

  it("leaves an already-canonical name untouched", () => {
    expect(rewriteSlashAlias("/ak-marketing:ak-cook", items)).toBe("/ak-marketing:ak-cook");
  });

  it("prefers an exact name over another item's alias", () => {
    const shadowing = [skill("ak:debug"), ...items];
    expect(rewriteSlashAlias("/ak:debug", shadowing)).toBe("/ak:debug");
  });

  it("passes unknown commands through for the SDK to report", () => {
    expect(rewriteSlashAlias("/nope arg", items)).toBe("/nope arg");
  });

  it("ignores messages that are not slash commands", () => {
    expect(rewriteSlashAlias("talk about /ak:debug", items)).toBe("talk about /ak:debug");
    expect(rewriteSlashAlias("", items)).toBe("");
  });

  it("ignores a bare slash", () => {
    expect(rewriteSlashAlias("/ ak:debug", items)).toBe("/ ak:debug");
  });
});
