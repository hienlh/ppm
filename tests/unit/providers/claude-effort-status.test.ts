import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  effortOverrides, effortStatusFromCli, estimateEffortStatus, readSettingsFiles, supportedLevels, userSettingsFile,
  type CliSettingsSource,
} from "../../../src/providers/claude-effort-status.ts";
import { CLAUDE_SETTING_SOURCES } from "../../../src/providers/claude-agent-sdk-query-options.ts";
import { effortInEffect } from "../../../src/shared/effort-status.ts";

const USER_FILE = "~/.claude/settings.json";
const src = (source: string, settings: Record<string, unknown>): CliSettingsSource => ({ source, settings });

describe("effortOverrides", () => {
  it("takes CLAUDE_CODE_EFFORT_LEVEL from the highest-priority settings file, over the environment", () => {
    // `get_settings` lists sources low to high; measured: local beats project beats user, and
    // any settings file beats the environment the CLI was started with.
    const sources = [
      src("userSettings", { env: { CLAUDE_CODE_EFFORT_LEVEL: "max" } }),
      src("projectSettings", { env: { CLAUDE_CODE_EFFORT_LEVEL: "medium" } }),
      src("localSettings", { env: { CLAUDE_CODE_EFFORT_LEVEL: "low" } }),
    ];
    expect(effortOverrides({ sources, processEnv: "xhigh", userFile: USER_FILE }).env)
      .toEqual({ value: "low", source: "localSettings", file: ".claude/settings.local.json" });
    expect(effortOverrides({ sources: sources.slice(0, 1), processEnv: "xhigh", userFile: USER_FILE }).env)
      .toEqual({ value: "max", source: "userSettings", file: USER_FILE });
    expect(effortOverrides({ sources: [], processEnv: "xhigh", userFile: USER_FILE }).env)
      .toEqual({ value: "xhigh", source: "environment" });
    expect(effortOverrides({ sources: [], userFile: USER_FILE }).env).toBeUndefined();
  });

  it("drops a value the CLI ignores, and lets it hide a lower one as the CLI does", () => {
    // The settings file's `env` is applied over the environment, so its bad value is what the CLI reads.
    const out = effortOverrides({ sources: [src("userSettings", { env: { CLAUDE_CODE_EFFORT_LEVEL: "extra" } })], processEnv: "low", userFile: USER_FILE });
    expect(out.env).toBeUndefined();
  });

  it("keeps the lowest cap, where max caps nothing and a model's own entry replaces its file's", () => {
    const sources = [
      src("userSettings", { maxEffortLevel: "xhigh" }),
      src("projectSettings", { maxEffortLevel: "max" }),
      src("localSettings", { maxEffortLevel: "high", modelSettings: { "claude-opus-4-7": { maxEffortLevel: "max" } } }),
    ];
    expect(effortOverrides({ sources, userFile: USER_FILE, model: "claude-sonnet-5" }).cap)
      .toEqual({ value: "high", source: "localSettings", file: ".claude/settings.local.json" });
    // The model's "max" exempts it from that file's cap, so the user file's is what is left.
    expect(effortOverrides({ sources, userFile: USER_FILE, model: "claude-opus-4-7[1m]" }).cap)
      .toEqual({ value: "xhigh", source: "userSettings", file: USER_FILE });
    expect(effortOverrides({ sources: [src("userSettings", { maxEffortLevel: "max" })], userFile: USER_FILE }).cap).toBeUndefined();
  });

  it("matches a model's entry across its dated, [1m], Bedrock and Vertex spellings", () => {
    const sources = [src("userSettings", { modelSettings: { "claude-opus-4-7": { maxEffortLevel: "medium" } } })];
    for (const model of ["claude-opus-4-7", "claude-opus-4-7[1m]", "claude-opus-4-7-20260101", "us.anthropic.claude-opus-4-7-v1:0", "claude-opus-4-7@20260101"]) {
      expect(effortOverrides({ sources, userFile: USER_FILE, model }).cap?.value).toBe("medium");
    }
    expect(effortOverrides({ sources, userFile: USER_FILE, model: "claude-opus-4-8" }).cap).toBeUndefined();
  });
});

describe("supportedLevels", () => {
  // The `initialize` answer's models, as the bundled CLI listed them.
  const models = [
    { value: "default", resolvedModel: "claude-opus-5-5[1m]", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
    { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
    { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", supportedEffortLevels: [] },
  ];

  it("finds the session's model by either name, with or without [1m]", () => {
    expect(supportedLevels(models, "claude-opus-5-5[1m]")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(supportedLevels(models, "claude-fable-5-1[1m]")).toHaveLength(5);
    expect(supportedLevels(models, "claude-haiku-4-5-20251001")).toEqual([]);
  });

  it("says nothing about a model the CLI did not list", () => {
    expect(supportedLevels(models, "claude-opus-4-6")).toBeUndefined();
    expect(supportedLevels(undefined, "claude-opus-5-5")).toBeUndefined();
  });
});

describe("effortStatusFromCli", () => {
  it("reports the user's global Max over PPM's High, as the real CLI answered", () => {
    const status = effortStatusFromCli({
      answer: {
        sources: [src("userSettings", { env: { CLAUDE_CODE_EFFORT_LEVEL: "max" } }), src("flagSettings", { permissions: { allow: [], deny: [] } })],
        applied: { model: "claude-opus-5-5[1m]", effort: "max" },
      },
      models: [{ value: "default", resolvedModel: "claude-opus-5-5[1m]", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] }],
      requested: "high",
      userFile: USER_FILE,
    });
    expect(status).toEqual({
      env: { value: "max", source: "userSettings", file: USER_FILE },
      observed: { requested: "high", applied: "max", model: "claude-opus-5-5[1m]" },
      supported: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(effortInEffect("high", status)).toEqual({ level: "max", reason: "env" });
  });

  it("keeps the CLI's null: a model without effort, or a variable that turns it off", () => {
    const status = effortStatusFromCli({ answer: { sources: [], applied: { model: "claude-haiku-4-5-20251001", effort: null } }, requested: "max", userFile: USER_FILE });
    expect(status.observed).toEqual({ requested: "max", applied: null, model: "claude-haiku-4-5-20251001" });
  });
});

describe("estimateEffortStatus", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "ppm-effort-"));
    dirs.push(root);
    const home = join(root, "home");
    const project = join(root, "project");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(project, ".claude"), { recursive: true });
    return { root, home, project };
  }

  it("reads the files a chat in the project reads, user first", () => {
    const { home, project } = fixture();
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_EFFORT_LEVEL: "max" }, maxEffortLevel: "xhigh" }));
    expect(estimateEffortStatus({ projectPath: project, env: {}, home })).toEqual({
      env: { value: "max", source: "userSettings", file: "~/.claude/settings.json" },
      cap: { value: "xhigh", source: "userSettings", file: "~/.claude/settings.json" },
    });
    writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_EFFORT_LEVEL: "medium" } }));
    expect(estimateEffortStatus({ projectPath: project, env: {}, home }).env).toEqual({ value: "medium", source: "projectSettings", file: ".claude/settings.json" });
  });

  it("leaves out .claude/settings.local.json, which a chat's CLI does not load", () => {
    const { home, project } = fixture();
    writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ env: { CLAUDE_CODE_EFFORT_LEVEL: "low" }, maxEffortLevel: "low" }));
    expect(estimateEffortStatus({ projectPath: project, env: {}, home })).toEqual({});
  });

  it("reads exactly the files of the sources a chat is started with", () => {
    const { home, project } = fixture();
    const user = join(home, ".claude", "settings.json");
    for (const [file, value] of [[user, "max"], [join(project, ".claude", "settings.json"), "high"], [join(project, ".claude", "settings.local.json"), "low"]] as const) {
      writeFileSync(file, JSON.stringify({ env: { CLAUDE_CODE_EFFORT_LEVEL: value } }));
    }
    const named = { user: "userSettings", project: "projectSettings", local: "localSettings" } as const;
    expect(readSettingsFiles(project, user).map((s) => s.source)).toEqual(CLAUDE_SETTING_SOURCES.map((s) => named[s]));
    // The mapping itself covers local, so adding it to the chat's sources would carry over here.
    expect(readSettingsFiles(project, user, ["user", "project", "local"]).map((s) => s.source)).toEqual(["userSettings", "projectSettings", "localSettings"]);
  });

  it("skips a file that does not parse, as the CLI skips it", () => {
    const { home, project } = fixture();
    writeFileSync(join(home, ".claude", "settings.json"), "{ // comments are not JSON\n }");
    expect(estimateEffortStatus({ projectPath: project, env: { CLAUDE_CODE_EFFORT_LEVEL: "medium" }, home }).env)
      .toEqual({ value: "medium", source: "environment" });
  });

  it("follows CLAUDE_CONFIG_DIR to the user settings", () => {
    const { root, home } = fixture();
    const configDir = join(root, "elsewhere");
    mkdirSync(configDir);
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_EFFORT_LEVEL: "high" } }));
    const status = estimateEffortStatus({ env: { CLAUDE_CONFIG_DIR: configDir }, home });
    expect(status.env).toEqual({ value: "high", source: "userSettings", file: join(configDir, "settings.json") });
    expect(userSettingsFile({}, home)).toEqual({ path: join(home, ".claude", "settings.json"), shown: "~/.claude/settings.json" });
  });

  it("shows the home folder as ~ on Windows too", () => {
    expect(userSettingsFile({}, "C:\\Users\\x", win32)).toEqual({ path: "C:\\Users\\x\\.claude\\settings.json", shown: "~/.claude/settings.json" });
    expect(userSettingsFile({ CLAUDE_CONFIG_DIR: "D:\\claude" }, "C:\\Users\\x", win32).shown).toBe("D:\\claude\\settings.json");
    // A sibling folder that only shares the home folder's name is not inside it. Each spelling
    // runs with its own path module, so the result is the same on every host.
    expect(userSettingsFile({ CLAUDE_CONFIG_DIR: "C:\\Users\\xy\\.claude" }, "C:\\Users\\x", win32).shown).toBe("C:\\Users\\xy\\.claude\\settings.json");
    expect(userSettingsFile({ CLAUDE_CONFIG_DIR: "/home/xy/.claude" }, "/home/x", posix).shown).toBe("/home/xy/.claude/settings.json");
  });
});

describe("SDK surface", () => {
  // `getSettings` is absent from sdk.d.ts; if an upgrade renames it the effort status would go
  // quiet at runtime, so fail here instead.
  it("still ships the undeclared get_settings request", () => {
    const sdk = readFileSync(require.resolve("@anthropic-ai/claude-agent-sdk"), "utf8");
    expect(sdk).toContain("async getSettings(");
    expect(sdk).toContain(`subtype:"get_settings"`);
  });
});
