/**
 * The PPM Assistant's decisions beyond the path rules: read-only shell commands run without a
 * card while that setting is on, nothing else does, and "act on its own" opens the provider's
 * tools only in turns the user started — never for a private folder.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { join } from "node:path";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import { configService } from "../../../src/services/config.service.ts";
import {
  assistantClaudeDecision, assistantCommandApprovalVerdict, assistantMayActOnOwn, assistantTurnStartedByUser,
  commandMentionsPrivateRoot, judgeShellScript, shellDecisionDeps,
} from "../../../src/services/assistant/assistant-shell-decision.ts";
import { assistantPolicySwitches, saveAssistantSettings } from "../../../src/services/assistant/assistant-settings.service.ts";
import { assistantTurnProvenance } from "../../../src/services/assistant/assistant-turn-provenance.ts";
import { DEFAULT_ASSISTANT_SETTINGS, readAssistantSettings } from "../../../src/shared/assistant-settings.ts";
import { ask, readonly } from "../../../src/services/assistant/readonly-shell/shell-verdict.ts";
import { adversarialBashCorpus, createCorpusFixture, q, type CorpusFixture } from "./readonly-shell/adversarial-bash-corpus.ts";

let fx: CorpusFixture;
const original = { ...shellDecisionDeps };
let switches = { autoReadonlyCommands: true, actOnOwn: false };
let userStarted = false;

beforeAll(() => {
  fx = createCorpusFixture();
  shellDecisionDeps.switches = () => switches;
  shellDecisionDeps.userStarted = async () => userStarted;
});
afterAll(() => {
  Object.assign(shellDecisionDeps, original);
  fx.cleanup();
});
afterEach(() => {
  switches = { autoReadonlyCommands: true, actOnOwn: false };
  userStarted = false;
  shellDecisionDeps.powershell = original.powershell;
  shellDecisionDeps.timeoutMs = original.timeoutMs;
});

/** The policy context a hook builds: projects, home, environment, and no trusted working directory. */
const ctx = () => ({ cwd: join(getPpmDir(), "assistant", "ppm"), projectRoots: [fx.proj, fx.proj2], home: fx.home, env: {}, installRoot: fx.install });
const decide = (tool: string, input: unknown) => assistantClaudeDecision("s1", tool, input, ctx());

describe("read-only commands", () => {
  it("run unasked when every path is inside a project", async () => {
    expect(await decide("Bash", { command: `git -C ${q(fx.proj)} log --oneline -20` })).toMatchObject({ decision: "allow", via: "readonly" });
    expect(await decide("Bash", { command: `cat ${q(join(fx.install, "src", "index.ts"))}` })).toMatchObject({ decision: "allow", via: "readonly" });
  });

  it("ask when they act on the current folder, which PPM cannot vouch for", async () => {
    expect((await decide("Bash", { command: "git status" })).decision).toBe("ask");
    expect((await decide("Bash", { command: "ls" })).decision).toBe("ask");
  });

  it("ask for every adversarial command", async () => {
    const asks = adversarialBashCorpus(fx).filter((c) => c.expected === "ask" && !c.ctx);
    expect(asks.length).toBeGreaterThan(40);
    const passed: string[] = [];
    for (const c of asks) if ((await decide("Bash", { command: c.command })).decision !== "ask") passed.push(c.command);
    expect(passed).toEqual([]);
  });

  it("ask in the background, outside the sandbox, or with no command", async () => {
    const command = `git -C ${q(fx.proj)} status`;
    expect((await decide("Bash", { command, run_in_background: true })).decision).toBe("ask");
    expect((await decide("Bash", { command, dangerouslyDisableSandbox: true })).decision).toBe("ask");
    expect((await decide("Bash", {})).decision).toBe("ask");
  });

  it("all ask while the setting is off", async () => {
    switches = { autoReadonlyCommands: false, actOnOwn: false };
    expect((await decide("Bash", { command: `git -C ${q(fx.proj)} log` })).decision).toBe("ask");
    expect((await assistantCommandApprovalVerdict({ shell: "bash", script: `git -C ${q(fx.proj)} log` }, ctx())).accept).toBe(false);
  });

  it("leave the path rules as they were, the install folder now included", async () => {
    expect(await decide("Read", { file_path: join(fx.proj, "a.json") })).toEqual({ decision: "allow", via: "policy" });
    expect(await decide("Read", { file_path: join(fx.install, "src", "index.ts") })).toEqual({ decision: "allow", via: "policy" });
    expect((await decide("Read", { file_path: join(fx.home, ".ssh", "id_rsa") })).decision).toBe("ask");
    expect((await decide("WebSearch", { query: "x" })).decision).toBe("ask");
  });
});

describe("PowerShell", () => {
  const cmd = { command: "Get-ChildItem C:\\x" };
  it("runs unasked only on a readonly verdict", async () => {
    shellDecisionDeps.powershell = async () => readonly("listing a project");
    expect(await decide("PowerShell", cmd)).toMatchObject({ decision: "allow", via: "readonly" });
    shellDecisionDeps.powershell = async () => ask("not on the list");
    expect((await decide("PowerShell", cmd)).decision).toBe("ask");
  });

  it("asks when the judge fails or takes too long", async () => {
    shellDecisionDeps.powershell = async () => { throw new Error("helper died"); };
    expect((await judgeShellScript("powershell", "dir", { projectRoots: [], home: fx.home })).verdict).toBe("ask");
    shellDecisionDeps.timeoutMs = 30;
    shellDecisionDeps.powershell = () => new Promise(() => {});
    const started = performance.now();
    expect(await decide("PowerShell", cmd)).toMatchObject({ decision: "ask", reason: "the read-only check took too long" });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it.if(process.platform === "win32")("reaches PowerShell's own parser through the real judge", async () => {
    expect(await decide("PowerShell", { command: `Get-ChildItem ${q(fx.proj)}` })).toMatchObject({ decision: "allow", via: "readonly" });
    expect((await decide("PowerShell", { command: `Remove-Item ${q(join(fx.proj, "f"))}` })).decision).toBe("ask");
  }, 20_000);

  it("never hands the judge a working directory", async () => {
    let seen: unknown = "unset";
    shellDecisionDeps.powershell = async (_s, c) => { seen = c.cwd; return ask("x"); };
    await decide("PowerShell", cmd);
    expect(seen).toBeUndefined();
  });
});

describe("acting on its own", () => {
  it("does nothing in a turn PPM started", async () => {
    switches = { autoReadonlyCommands: true, actOnOwn: true };
    for (const [tool, input] of [["WebSearch", { query: "x" }], ["Bash", { command: "npm test" }], ["Edit", { file_path: join(fx.proj, "a.json") }]] as const) {
      expect((await decide(tool, input)).decision).toBe("ask");
    }
    expect(await assistantMayActOnOwn(["s1"])).toBe(false);
  });

  it("lets the provider's tools run in a turn the user started", async () => {
    switches = { autoReadonlyCommands: true, actOnOwn: true };
    userStarted = true;
    expect(await assistantMayActOnOwn(["s1"])).toBe(true);
    for (const [tool, input] of [
      ["WebSearch", { query: "x" }], ["Bash", { command: "npm test" }], ["PowerShell", { command: "Remove-Item C:\\work\\tmp -Recurse" }],
      ["Edit", { file_path: join(fx.proj, "a.json") }], ["Write", { file_path: join(fx.proj, "new.ts") }],
      ["Read", { file_path: join(fx.outside) }], ["mcp__github__create_issue", {}],
    ] as const) {
      expect(await decide(tool, input)).toMatchObject({ decision: "allow", via: "act_on_own" });
    }
  });

  it("still asks for anything that reaches a private folder", async () => {
    switches = { autoReadonlyCommands: true, actOnOwn: true };
    userStarted = true;
    for (const [tool, input] of [
      ["Read", { file_path: join(fx.home, ".ssh", "id_rsa") }],
      ["Read", { file_path: join(getPpmDir(), "ppm.db") }],
      ["Grep", { pattern: "token", path: fx.home }],
      ["Write", { file_path: join(getPpmDir(), "x.txt") }],
      ["Edit", { file_path: "notes.txt" }],
      ["Bash", { command: "cat ~/.ssh/id_rsa" }],
      ["Bash", { command: `sqlite3 ${q(join(getPpmDir(), "ppm.db"))} 'delete from config'` }],
      ["Bash", { command: "cd .. && rm -rf *" }],
      ["PowerShell", { command: "Get-Content $env:USERPROFILE\\.aws\\credentials" }],
    ] as const) {
      expect((await decide(tool, input)).decision).toBe("ask");
    }
  });
});

describe("commandMentionsPrivateRoot", () => {
  it("finds a private root however its path is spelled", () => {
    const home = fx.home;
    for (const c of [
      "cat $HOME/.ssh/id_rsa", "type %USERPROFILE%\\.aws\\credentials", `cat ${join(home, ".npmrc")}`,
      "sqlite3 ppm.dev.db .tables", "cat ../x", "ls ..", `rm -rf ${getPpmDir().replace(/\\/g, "\\\\")}`,
    ]) expect(commandMentionsPrivateRoot(c, home, {})).toBe(true);
  });

  it("does not treat a discarded stream or a range as one", () => {
    for (const c of ["npm test 2>/dev/null", "1..10 | % { $_ }", "git log HEAD...main", "npm run build"]) {
      expect(commandMentionsPrivateRoot(c, fx.home, {})).toBe(false);
    }
  });
});

describe("who started the turn", () => {
  it("counts only a turn the tracker saw the user open", async () => {
    const spy = spyOn(assistantTurnProvenance, "provenance");
    try {
      spy.mockReturnValue({ startedBy: "user_ppm", untrusted: false });
      expect(await assistantTurnStartedByUser(["a"])).toBe(true);
      spy.mockReturnValue({ startedBy: "user_telegram", untrusted: true, reason: "read" });
      expect(await assistantTurnStartedByUser(["a"])).toBe(true);
      spy.mockReturnValue({ startedBy: "user_ppm", untrusted: true, reason: "unknown" });
      expect(await assistantTurnStartedByUser(["a"])).toBe(false);
      spy.mockReturnValue({ startedBy: "ppm", untrusted: true, reason: "news" });
      expect(await assistantTurnStartedByUser(["a"])).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(await assistantTurnStartedByUser(["never-seen"])).toBe(false);
  });
});

describe("settings", () => {
  it("default to read-only commands on and acting on its own off, and reject anything but true or false", () => {
    expect(DEFAULT_ASSISTANT_SETTINGS.auto_readonly_commands).toBe(true);
    expect(DEFAULT_ASSISTANT_SETTINGS.act_on_own).toBe(false);
    expect(readAssistantSettings({}).value).toMatchObject({ auto_readonly_commands: true, act_on_own: false });
    const bad = readAssistantSettings({ auto_readonly_commands: "yes", act_on_own: 1 });
    expect(bad.errors).toEqual(["auto_readonly_commands must be true or false", "act_on_own must be true or false"]);
    expect(bad.value).toMatchObject({ auto_readonly_commands: true, act_on_own: false });
  });

  it("are read on every call, and a save that does not name them keeps them", () => {
    const saved = configService.get("assistant");
    try {
      expect(saveAssistantSettings({ act_on_own: true, auto_readonly_commands: false }, () => true).ok).toBe(true);
      expect(assistantPolicySwitches()).toEqual({ autoReadonlyCommands: false, actOnOwn: true });
      expect(saveAssistantSettings({ instructions: "hi" }, () => true).ok).toBe(true);
      expect(assistantPolicySwitches()).toEqual({ autoReadonlyCommands: false, actOnOwn: true });
      expect(saveAssistantSettings({ act_on_own: false }, () => true).ok).toBe(true);
      expect(assistantPolicySwitches()).toEqual({ autoReadonlyCommands: false, actOnOwn: false });
    } finally {
      configService.set("assistant", saved as never);
    }
  });
});
