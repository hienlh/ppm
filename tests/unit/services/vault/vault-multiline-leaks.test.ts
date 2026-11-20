/**
 * Multi-line vault values on their way out of PPM: the trace keeps item names only (never a line
 * of a value that looks like an item line), the scrubber catches a value repeated one line at a
 * time, and Telegram's formatter and splitter take a value out before Markdown or a cut can
 * change its shape.
 */
import { afterEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { createTurnSecretScrubber, secretFragments, turnSecretScrubber } from "../../../../src/services/vault/turn-secret-scrubber.ts";
import { filterVaultTraceRecord } from "../../../../src/services/vault/vault-trace-filter.ts";
import { markdownToTelegramHtml, splitTelegramHtml } from "../../../../src/services/telegram/telegram-html-format.ts";
import { redactJsonlFile } from "../../../../src/services/vault/transcript-redactor.ts";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

afterEach(() => turnSecretScrubber.clear());

const CODES = "- 7F3K-QX2M-88PL\n- A9WD-4TRN-0ZEC\n- M2HV-KK19-PXQ5";

describe("session trace", () => {
  it("lists only real item names, never a value line that starts like an item", () => {
    const output = `Vault items (secure tier). Use them only…\n- Recovery codes (Other): ${CODES.replace(/\n/g, "\n    ")}`;
    const rec = filterVaultTraceRecord("s1", { type: "tool_result", output }, createTurnSecretScrubber(), () => ["Recovery codes"]);
    expect(rec).toMatchObject({ withheld: true, tier: "secure", items: ["Recovery codes"] });
    expect(JSON.stringify(rec)).not.toMatch(/7F3K|A9WD|M2HV/);
  });

  it("drops a would-be name that is no item, even from a result written the old way", () => {
    const output = `Vault items (sealed tier). …\n- Recovery codes (Other): ${CODES}`;
    const rec = filterVaultTraceRecord("s1", { type: "tool_result", output }, createTurnSecretScrubber(), () => ["Recovery codes"]);
    expect(rec).toMatchObject({ items: ["Recovery codes"] });
    expect(JSON.stringify(rec)).not.toMatch(/7F3K|A9WD|M2HV/);
  });
});

describe("scrubber", () => {
  it("holds a multi-line value whole and each distinctive line, never a short common one", () => {
    expect(secretFragments("Flat 4, 18 Harbour Road\nLeith\nEdinburgh\nEH6 6LQ")).toEqual(["Flat 4, 18 Harbour Road\nLeith\nEdinburgh\nEH6 6LQ", "Flat 4, 18 Harbour Road"]);
    expect(secretFragments("single line value")).toEqual(["single line value"]);
    const s = createTurnSecretScrubber();
    s.hold("a", [{ name: "Codes", value: CODES }, { name: "Home", value: "Flat 4, 18 Harbour Road\nLeith\nEdinburgh" }]);
    expect(s.scrub(CODES, "a")).toBe("[vault:Codes]");
    expect(s.scrub("your second code is A9WD-4TRN-0ZEC", "a")).toBe("your second code is [vault:Codes]");
    expect(s.scrub("I live at Flat 4, 18 Harbour Road.", "a")).toBe("I live at [vault:Home].");
    // A line too short or too common to stand alone is left in ordinary text.
    expect(s.scrub("Edinburgh is nice", "a")).toBe("Edinburgh is nice");
  });
});

describe("Telegram", () => {
  it("takes a value out before Markdown turns its lines into bullets", () => {
    turnSecretScrubber.hold("s1", [{ name: "Codes", value: CODES }]);
    const html = markdownToTelegramHtml(`Here they are:\n${CODES}\nDone.`);
    expect(html).not.toMatch(/7F3K|A9WD|M2HV/);
    expect(html).toContain("[vault:Codes]");
  });

  it("takes a value out before a cut could leave half of it in each message", () => {
    const value = Array.from({ length: 40 }, (_, i) => `line-${i}-SECRETPART-${i}`).join("\n");
    turnSecretScrubber.hold("s1", [{ name: "Key", value }]);
    const html = `${"x".repeat(3900)}\n${value}\nend`;
    const parts = splitTelegramHtml(html, 4096);
    expect(parts.join("")).not.toContain("SECRETPART");
  });
});

describe("history files", () => {
  it("rewrites a single repeated line of a multi-line value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-redact-"));
    const file = join(dir, "t.jsonl");
    writeFileSync(file, `${JSON.stringify({ message: { content: "second code: A9WD-4TRN-0ZEC" } })}\n`);
    expect(await redactJsonlFile(file, [{ name: "Codes", value: CODES }])).toBe("changed");
    expect(readFileSync(file, "utf8")).not.toContain("A9WD");
  });
});

describe("vault_read output", () => {
  it("hands a multi-line value over byte for byte in a fence longer than any backtick run inside it", async () => {
    const { valueBlock } = await import("../../../../src/services/vault/vault-tools.ts");
    const key = "-----BEGIN KEY-----\nabc```def\n-----END KEY-----";
    const block = valueBlock(key);
    expect(block).toContain("\n````\n" + key + "\n````");
    expect(valueBlock("one line")).toBe("one line");
  });

  it("does not hold a key's BEGIN/END armour on its own, and caps the lines held", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line-number-${i}-abcdef`);
    const value = ["-----BEGIN OPENSSH PRIVATE KEY-----", ...lines, "-----END OPENSSH PRIVATE KEY-----"].join("\n");
    const f = secretFragments(value);
    expect(f[0]).toBe(value);
    expect(f.slice(1).some((l) => l.includes("BEGIN") || l.includes("END"))).toBe(false);
    expect(f.length).toBe(1 + 24);
  });
});
