import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { memoryRevision, parseMemoryFile, serializeMemoryFile, type MemoryFileFields } from "../../../src/services/memory/memory-file.ts";

const sha12 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

const EXAMPLE = `---
name: Bash tool shell is zsh
description: unquoted $LIST is one argument, \`echo ====\` is an equals expansion
type: feedback
source: claude
created: 2026-11-12T03:10:00Z
updated: 2026-11-12T03:10:00Z
origin: ~/.claude/projects/-home-thawngho-Projects-ppm/memory/bash-tool-shell-is-zsh.md
origin_hash: 5e1a9f
---
Body line one.

Body line three.
`;

describe("parseMemoryFile", () => {
  it("reads every field of the flat frontmatter and the body", () => {
    const m = parseMemoryFile(EXAMPLE, "claude-bash-tool-shell-is-zsh", "project");
    expect(m).toEqual({
      id: "claude-bash-tool-shell-is-zsh",
      scope: "project",
      name: "Bash tool shell is zsh",
      description: "unquoted $LIST is one argument, `echo ====` is an equals expansion",
      type: "feedback",
      source: "claude",
      created: "2026-11-12T03:10:00Z",
      updated: "2026-11-12T03:10:00Z",
      origin: "~/.claude/projects/-home-thawngho-Projects-ppm/memory/bash-tool-shell-is-zsh.md",
      originHash: "5e1a9f",
      body: "Body line one.\n\nBody line three.",
      revision: sha12(EXAMPLE),
    });
  });

  it("takes the revision from the first 12 hex of the sha256 of the whole file", () => {
    expect(memoryRevision(EXAMPLE)).toBe(sha12(EXAMPLE));
    expect(memoryRevision(EXAMPLE)).toMatch(/^[0-9a-f]{12}$/);
    const changed = EXAMPLE.replace("three", "four");
    expect(parseMemoryFile(changed, "x", "project").revision).not.toBe(parseMemoryFile(EXAMPLE, "x", "project").revision);
  });

  it("reads archived: true", () => {
    const m = parseMemoryFile("---\nname: a\ndescription: b\ntype: user\nsource: ppm\narchived: true\n---\nx\n", "m-1", "global");
    expect(m.archived).toBe(true);
    expect(m.scope).toBe("global");
  });

  it("leaves archived unset when the key is absent", () => {
    const m = parseMemoryFile("---\nname: a\ndescription: b\n---\nx\n", "m-1", "project");
    expect(m.archived).toBeUndefined();
    expect(m.origin).toBeUndefined();
    expect(m.originHash).toBeUndefined();
  });

  it("reads a file with no frontmatter: the file name is the name, the first line the description (2.5)", () => {
    const text = "\nRemember to run migrations first.\nSecond line.\n";
    const m = parseMemoryFile(text, "run-migrations", "project");
    expect(m.name).toBe("run-migrations");
    expect(m.description).toBe("Remember to run migrations first.");
    expect(m.body).toBe("\nRemember to run migrations first.\nSecond line.");
    expect(m.type).toBe("project");
    expect(m.source).toBe("ppm");
    expect(m.revision).toBe(sha12(text));
  });

  it("falls back field by field when the frontmatter lacks name or description", () => {
    const m = parseMemoryFile("---\ntype: user\n---\nFirst body line\nmore\n", "no-name", "project");
    expect(m.name).toBe("no-name");
    expect(m.description).toBe("First body line");
    expect(m.type).toBe("user");
  });

  it("treats an unclosed frontmatter as no frontmatter, so a broken file is still readable", () => {
    const text = "---\nname: broken\nno closing fence here\n";
    const m = parseMemoryFile(text, "broken-file", "project");
    expect(m.name).toBe("broken-file");
    expect(m.body).toBe("---\nname: broken\nno closing fence here");
  });

  it("accepts type under metadata:, as Claude sometimes writes it", () => {
    const text = "---\nname: n\ndescription: d\nmetadata:\n  type: reference\n  other: x\n---\nbody\n";
    expect(parseMemoryFile(text, "a", "project").type).toBe("reference");
  });

  it("prefers a valid root type over metadata.type", () => {
    const text = "---\nname: n\ntype: user\nmetadata:\n  type: reference\n---\nbody\n";
    expect(parseMemoryFile(text, "a", "project").type).toBe("user");
  });

  it("maps an unknown type to project and an unknown or missing source to ppm", () => {
    const m = parseMemoryFile("---\nname: n\ntype: whatever\nsource: martian\n---\nb\n", "a", "project");
    expect(m.type).toBe("project");
    expect(m.source).toBe("ppm");
    expect(parseMemoryFile("---\nname: n\n---\nb\n", "a", "project").source).toBe("ppm");
  });

  it("unquotes double- and single-quoted values", () => {
    const text = `---\nname: "Colon: inside"\ndescription: 'it''s quoted'\n---\nb\n`;
    const m = parseMemoryFile(text, "a", "project");
    expect(m.name).toBe("Colon: inside");
    expect(m.description).toBe("it's quoted");
  });

  it("reads a CRLF file and one starting with a BOM", () => {
    const crlf = "---\r\nname: n\r\ndescription: d\r\ntype: user\r\n---\r\nbody\r\n";
    const a = parseMemoryFile(crlf, "a", "project");
    expect(a.name).toBe("n");
    expect(a.description).toBe("d");
    expect(a.type).toBe("user");
    expect(a.body).toBe("body");
    const bom = "﻿---\nname: n\n---\nbody\n";
    expect(parseMemoryFile(bom, "a", "project").name).toBe("n");
  });

  it("keeps a --- line inside the body as body", () => {
    const text = "---\nname: n\n---\nabove\n---\nbelow\n";
    expect(parseMemoryFile(text, "a", "project").body).toBe("above\n---\nbelow");
  });
});

describe("serializeMemoryFile", () => {
  const fields: MemoryFileFields = {
    name: "Bash tool shell is zsh",
    description: "unquoted $LIST is one argument, `echo ====` is an equals expansion",
    type: "feedback",
    source: "claude",
    created: "2026-11-12T03:10:00Z",
    updated: "2026-11-12T03:10:00Z",
    origin: "~/.claude/projects/-home-thawngho-Projects-ppm/memory/bash-tool-shell-is-zsh.md",
    originHash: "5e1a9f",
    body: "Body line one.\n\nBody line three.",
  };

  it("writes the flat frontmatter in the design's order, then the body", () => {
    expect(serializeMemoryFile(fields)).toBe(EXAMPLE);
  });

  it("writes archived only when true and leaves out absent origin fields", () => {
    const text = serializeMemoryFile({ ...fields, archived: true, origin: undefined, originHash: undefined, source: "ppm" });
    expect(text).toContain("\narchived: true\n");
    expect(text).not.toContain("origin");
    expect(serializeMemoryFile({ ...fields, archived: false })).not.toContain("archived");
  });

  it("round-trips awkward values through parse", () => {
    const awkward: MemoryFileFields = {
      name: "# starts like a comment",
      description: "has: a colon, 'quotes' and \"doubles\"\nand a newline ",
      type: "reference",
      source: "ppm",
      created: "2026-11-12T03:10:00Z",
      updated: "2026-11-12T04:00:00Z",
      archived: true,
      origin: "codex:019a-thread",
      originHash: "abc",
      body: "line\n---\nafter a fence",
    };
    const text = serializeMemoryFile(awkward);
    const back = parseMemoryFile(text, "m-deadbeef", "global");
    expect(back).toEqual({ ...awkward, id: "m-deadbeef", scope: "global", revision: sha12(text) });
  });

  it("round-trips an empty description and values YAML would read as other types", () => {
    const odd: MemoryFileFields = { ...fields, name: "true", description: "", origin: "123", originHash: "null" };
    const back = parseMemoryFile(serializeMemoryFile(odd), "x", "project");
    expect(back.name).toBe("true");
    expect(back.description).toBe("");
    expect(back.origin).toBe("123");
    expect(back.originHash).toBe("null");
  });

  it("is stable: serializing what it parsed gives the same bytes", () => {
    const once = serializeMemoryFile(fields);
    const parsed = parseMemoryFile(once, "x", "project");
    expect(serializeMemoryFile(parsed)).toBe(once);
  });
});
