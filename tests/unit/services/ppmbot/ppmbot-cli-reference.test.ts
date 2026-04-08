import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_CLI_REFERENCE } from "../../../../src/services/ppmbot/cli-reference-default.ts";
import { VERSION } from "../../../../src/version.ts";
import {
  readCliReference,
  ensureCoordinatorWorkspace,
} from "../../../../src/services/ppmbot/ppmbot-session.ts";

const BOT_DIR = join(homedir(), ".ppm", "bot");
const CLI_REF_PATH = join(BOT_DIR, "cli-reference.md");
const COORDINATOR_PATH = join(BOT_DIR, "coordinator.md");
const SETTINGS_PATH = join(BOT_DIR, ".claude", "settings.local.json");

// ── DEFAULT_CLI_REFERENCE constant ──────────────────────────────────

describe("DEFAULT_CLI_REFERENCE constant", () => {
  it("should be a non-empty string", () => {
    expect(typeof DEFAULT_CLI_REFERENCE).toBe("string");
    expect(DEFAULT_CLI_REFERENCE.length).toBeGreaterThan(100);
  });

  it("should start with PPM CLI Reference heading", () => {
    expect(DEFAULT_CLI_REFERENCE).toStartWith("# PPM CLI Reference");
  });

  it("should contain all major command groups", () => {
    const groups = [
      "Core Commands",
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
      expect(DEFAULT_CLI_REFERENCE).toContain(group);
    }
  });

  it("should contain nested sub-commands (git branch, bot memory)", () => {
    expect(DEFAULT_CLI_REFERENCE).toContain("ppm git branch create");
    expect(DEFAULT_CLI_REFERENCE).toContain("ppm bot memory save");
    expect(DEFAULT_CLI_REFERENCE).toContain("ppm bot project list");
  });

  it("should not have version header (raw constant)", () => {
    expect(DEFAULT_CLI_REFERENCE).not.toContain("<!-- ppm-version:");
  });
});

// ── readCliReference ─────────────────────────────────────────────────

describe("readCliReference", () => {
  it("should return a non-empty string with CLI content", () => {
    // ensureCoordinatorWorkspace() has been called previously so the file exists
    ensureCoordinatorWorkspace();
    const content = readCliReference();
    expect(typeof content).toBe("string");
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("# PPM CLI Reference");
  });

  it("should include version header from file", () => {
    const content = readCliReference();
    expect(content).toContain("<!-- ppm-version:");
  });
});

// ── ensureCoordinatorWorkspace ────────────────────────────────────────

describe("ensureCoordinatorWorkspace", () => {
  it("should create all required files", () => {
    ensureCoordinatorWorkspace();

    expect(existsSync(BOT_DIR)).toBe(true);
    expect(existsSync(COORDINATOR_PATH)).toBe(true);
    expect(existsSync(SETTINGS_PATH)).toBe(true);
    expect(existsSync(CLI_REF_PATH)).toBe(true);
  });

  it("should write coordinator.md with identity content", () => {
    ensureCoordinatorWorkspace();
    const content = readFileSync(COORDINATOR_PATH, "utf-8");
    expect(content).toContain("PPMBot");
  });

  it("should write settings.local.json with tool permissions", () => {
    ensureCoordinatorWorkspace();
    const raw = readFileSync(SETTINGS_PATH, "utf-8");
    const settings = JSON.parse(raw);
    expect(settings.permissions).toBeDefined();
    expect(settings.permissions.allow).toBeArray();
    expect(settings.permissions.allow).toContain("Bash");
  });

  it("should write cli-reference.md with version and content", () => {
    ensureCoordinatorWorkspace();
    const content = readFileSync(CLI_REF_PATH, "utf-8");
    expect(content).toContain(`<!-- ppm-version: ${VERSION} -->`);
    expect(content).toContain("# PPM CLI Reference");
  });
});

// ── Version-based regeneration ────────────────────────────────────────

describe("CLI reference version check", () => {
  let backup: string | null = null;

  beforeEach(() => {
    // Backup existing cli-reference.md
    if (existsSync(CLI_REF_PATH)) {
      backup = readFileSync(CLI_REF_PATH, "utf-8");
    }
  });

  afterEach(() => {
    // Restore original content
    if (backup !== null) {
      writeFileSync(CLI_REF_PATH, backup);
    }
  });

  it("should regenerate when version header is outdated", () => {
    // Write file with old version
    writeFileSync(CLI_REF_PATH, "<!-- ppm-version: 0.0.1 -->\n# Old CLI Reference");

    ensureCoordinatorWorkspace();

    const content = readFileSync(CLI_REF_PATH, "utf-8");
    expect(content).not.toContain("ppm-version: 0.0.1");
    expect(content).toContain(`ppm-version: ${VERSION}`);
    expect(content).toContain("# PPM CLI Reference");
  });

  it("should regenerate when version header is missing", () => {
    // Write file with no version header
    writeFileSync(CLI_REF_PATH, "# Some old content without version");

    ensureCoordinatorWorkspace();

    const content = readFileSync(CLI_REF_PATH, "utf-8");
    expect(content).toContain(`ppm-version: ${VERSION}`);
    expect(content).toContain("# PPM CLI Reference");
  });

  it("should NOT regenerate when version matches current", () => {
    // Write current version with custom trailing content
    const marker = "CUSTOM_TEST_MARKER_12345";
    const customContent = `<!-- ppm-version: ${VERSION} -->\n# PPM CLI Reference\n${marker}`;
    writeFileSync(CLI_REF_PATH, customContent);

    ensureCoordinatorWorkspace();

    const content = readFileSync(CLI_REF_PATH, "utf-8");
    // Should be untouched — marker preserved
    expect(content).toContain(marker);
    expect(content).toBe(customContent);
  });

  it("should regenerate when file is deleted", () => {
    if (existsSync(CLI_REF_PATH)) unlinkSync(CLI_REF_PATH);

    ensureCoordinatorWorkspace();

    expect(existsSync(CLI_REF_PATH)).toBe(true);
    const content = readFileSync(CLI_REF_PATH, "utf-8");
    expect(content).toContain(`ppm-version: ${VERSION}`);
  });
});
