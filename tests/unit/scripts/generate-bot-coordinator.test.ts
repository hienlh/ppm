import { describe, it, expect, beforeAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const SCRIPT = resolve(ROOT, "scripts/generate-bot-coordinator.ts");

/** Run the generator script with --cli-only and return stdout */
function runGenerator(): string {
  const result = spawnSync("bun", [SCRIPT, "--cli-only"], {
    cwd: ROOT,
    timeout: 15_000,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(`Generator failed: ${result.stderr}`);
  }
  return result.stdout;
}

describe("generate-bot-coordinator script", () => {
  let output: string;

  beforeAll(() => {
    output = runGenerator();
  });

  // ── Structure ──────────────────────────────────────────────────

  it("should start with CLI reference heading", () => {
    expect(output).toStartWith("# PPM CLI Reference");
  });

  it("should contain Core Commands section", () => {
    expect(output).toContain("## Core Commands");
  });

  it("should contain all command group sections", () => {
    const groups = [
      "ppm projects",
      "ppm config",
      "ppm git",
      "ppm chat",
      "ppm db",
      "ppm autostart",
      "ppm cloud",
      "ppm ext",
      "ppm bot",
    ];
    for (const group of groups) {
      expect(output).toContain(`## ${group}`);
    }
  });

  it("should contain Quick Reference sections", () => {
    expect(output).toContain("## Quick Reference — Task Delegation");
    expect(output).toContain("## Quick Reference — Memory");
  });

  it("should contain Tips section", () => {
    expect(output).toContain("## Tips");
  });

  // ── Core Commands ──────────────────────────────────────────────

  it("should include ppm start with options", () => {
    expect(output).toContain("ppm start");
    expect(output).toContain("-p, --port <port>");
  });

  it("should include ppm stop with options", () => {
    expect(output).toContain("ppm stop");
    expect(output).toContain("--kill");
  });

  it("should include ppm status", () => {
    expect(output).toContain("ppm status");
    expect(output).toContain("--json");
  });

  it("should include ppm init with options", () => {
    expect(output).toContain("ppm init");
    expect(output).toContain("--scan <path>");
    expect(output).toContain("-y, --yes");
  });

  // ── Nested Sub-groups ──────────────────────────────────────────

  it("should resolve git branch sub-commands (nested group)", () => {
    expect(output).toContain("ppm git branch create");
    expect(output).toContain("ppm git branch checkout");
    expect(output).toContain("ppm git branch delete");
    expect(output).toContain("ppm git branch merge");
  });

  it("should resolve bot memory sub-commands (nested group)", () => {
    expect(output).toContain("ppm bot memory save");
    expect(output).toContain("ppm bot memory list");
    expect(output).toContain("ppm bot memory forget");
  });

  it("should resolve bot project sub-commands (nested group)", () => {
    expect(output).toContain("ppm bot project list");
  });

  it("should NOT have double group prefix (e.g. 'ppm git git status')", () => {
    expect(output).not.toContain("ppm git git");
    expect(output).not.toContain("ppm bot bot");
    expect(output).not.toContain("ppm db db");
    expect(output).not.toContain("ppm cloud cloud");
  });

  // ── Descriptions ───────────────────────────────────────────────

  it("should parse descriptions with embedded double quotes", () => {
    // e.g. 'Stage files (use "." to stage all)'
    expect(output).toContain("ppm git stage");
    expect(output).toMatch(/Stage files/);
  });

  it("should include descriptions for sub-commands", () => {
    expect(output).toMatch(/Show working tree status/);
    expect(output).toMatch(/Show recent commits/);
    expect(output).toMatch(/Create a new chat session/);
  });

  // ── Options & Arguments ────────────────────────────────────────

  it("should parse required options", () => {
    // bot delegate has required options
    expect(output).toContain("ppm bot delegate");
    expect(output).toContain("--chat <id>");
    expect(output).toContain("--project <name>");
    expect(output).toContain("--prompt <text>");
  });

  it("should parse default values", () => {
    // e.g. [default: 50], [default: 20]
    expect(output).toMatch(/\[default: \d+\]/);
  });

  it("should parse command arguments", () => {
    // e.g. ppm git diff [ref1] [ref2], ppm db query <name> <sql>
    expect(output).toMatch(/ppm git diff.*\[ref1\]/);
    expect(output).toMatch(/ppm db query.*<name>.*<sql>/);
  });

  // ── Format ─────────────────────────────────────────────────────

  it("should wrap commands in code blocks", () => {
    const codeBlockCount = (output.match(/```/g) || []).length;
    // Each group has opening + closing = 2 per group, plus quick reference blocks
    expect(codeBlockCount).toBeGreaterThanOrEqual(20);
  });

  it("should not contain version header (--cli-only mode)", () => {
    expect(output).not.toContain("<!-- ppm-version:");
  });
});
