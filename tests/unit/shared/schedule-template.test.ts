import { describe, it, expect } from "bun:test";
import {
  parseScheduleTemplate,
  serializeScheduleTemplate,
  scheduleTemplateFileName,
  templateFromSchedule,
  type TemplateSource,
} from "../../../src/shared/schedule-template.ts";

const scriptTemplate = {
  ppmScheduleTemplate: 1,
  name: "GitHub to ntfy",
  description: "Pushes GitHub notifications to an ntfy topic.",
  kind: "script",
  mode: "tick",
  cron: "0 * * * * *",
  script: "export default async function (ctx) { ctx.log('hi'); }",
  inputs: [
    { key: "server", label: "ntfy server", type: "text", required: true, default: "https://ntfy.sh" },
    { key: "token", label: "ntfy token", type: "secret" },
    { key: "pollSeconds", label: "Poll every", type: "number", default: 60 },
    { key: "dryRun", label: "Dry run", type: "boolean", default: true },
  ],
  timeoutMs: 600_000,
  permissionMode: "bypassPermissions",
};

const errorsOf = (input: unknown): string[] => {
  const r = parseScheduleTemplate(input);
  return r.ok ? [] : r.errors;
};
const withChange = (change: Record<string, unknown>) => ({ ...scriptTemplate, ...change });

describe("parseScheduleTemplate", () => {
  it("accepts a valid script template and keeps it as written", () => {
    const r = parseScheduleTemplate(JSON.stringify(scriptTemplate));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.template).toEqual(scriptTemplate as never);
  });

  it("refuses a format it does not know, saying why", () => {
    expect(errorsOf(withChange({ ppmScheduleTemplate: 2 }))[0]).toContain("newer PPM");
    expect(errorsOf(withChange({ ppmScheduleTemplate: "1" }))[0]).toContain("Unknown template format");
    expect(errorsOf({ name: "x" })[0]).toContain("not a PPM schedule template");
    expect(errorsOf("{ nope")[0]).toContain("not JSON");
    expect(errorsOf("ghp_tokenPickedByMistake0123\n")).toEqual(["This file is not JSON"]);
  });

  it("refuses an unknown field instead of dropping it", () => {
    expect(errorsOf(withChange({ sessionId: "abc" }))).toContain('Unknown field "sessionId"');
    const inputs = [{ key: "a", label: "A", type: "text", secretValue: "x" }];
    expect(errorsOf(withChange({ inputs }))).toContain('inputs[0]: unknown field "secretValue"');
  });

  it("refuses a secret input that carries a default", () => {
    const inputs = [{ key: "token", label: "Token", type: "secret", default: "xoxp-123" }];
    expect(errorsOf(withChange({ inputs })).join("\n")).toContain("a secret cannot have a default");
  });

  it("checks each input's key, label, type and default", () => {
    const errors = errorsOf(withChange({
      inputs: [
        { key: "1bad", label: "Bad key", type: "text" },
        { key: "dup", label: "One", type: "text" },
        { key: "dup", label: "Two", type: "text" },
        { key: "n", label: "N", type: "number", default: "5" },
        { key: "t", label: "", type: "text" },
        { key: "x", label: "X", type: "date" },
        { key: "r", label: "R", type: "text", required: "yes" },
      ],
    })).join("\n");
    expect(errors).toContain("inputs[0]: key must be");
    expect(errors).toContain('key "dup" is declared twice');
    expect(errors).toContain('input "n": default must be a number');
    expect(errors).toContain('input "t": label must be');
    expect(errors).toContain('input "x": type must be');
    expect(errors).toContain('input "r": required must be');
  });

  it("a prompt template is a 5-field cron, a prompt, and nothing a script has", () => {
    const prompt = { ppmScheduleTemplate: 1, name: "Daily", kind: "prompt", mode: "tick", cron: "0 9 * * *", prompt: "Summarise" };
    expect(errorsOf(prompt)).toEqual([]);
    expect(errorsOf({ ...prompt, cron: "0 0 9 * * *" }).join()).toContain("5 cron fields");
    expect(errorsOf({ ...prompt, mode: "always-on", cron: undefined }).join()).toContain("cannot be always on");
    expect(errorsOf({ ...prompt, script: "x" }).join()).toContain("has no script");
    expect(errorsOf({ ...prompt, inputs: [{ key: "a", label: "A", type: "text" }] }).join()).toContain("Only a script");
    expect(errorsOf({ ...prompt, prompt: " " }).join()).toContain("needs a prompt");
  });

  it("a script template needs a script, and no prompt", () => {
    expect(errorsOf(withChange({ script: "" })).join()).toContain("needs a script");
    expect(errorsOf(withChange({ prompt: "hi" })).join()).toContain("has no prompt");
    expect(errorsOf(withChange({ script: "x".repeat(1_000_001) })).join()).toContain("larger than 1 MB");
  });

  it("an always-on template has neither a cron nor a run timeout; a tick one needs a cron", () => {
    const daemon = withChange({ mode: "always-on", cron: undefined, timeoutMs: undefined });
    expect(errorsOf(daemon)).toEqual([]);
    expect(errorsOf({ ...daemon, cron: "* * * * *" }).join()).toContain("has no cron");
    expect(errorsOf({ ...daemon, timeoutMs: 60_000 }).join()).toContain("no run timeout");
    expect(errorsOf(withChange({ cron: undefined })).join()).toContain("needs a cron");
    expect(errorsOf(withChange({ cron: "*/2 * * * * *" })).join()).toContain("every 5 seconds");
  });

  it("checks the budgets and the permission mode", () => {
    expect(errorsOf(withChange({ timeoutMs: 5_000 })).join()).toContain("timeoutMs");
    const prompt = { ppmScheduleTemplate: 1, name: "Daily", kind: "prompt", mode: "tick", cron: "0 9 * * *", prompt: "Summarise" };
    expect(errorsOf({ ...prompt, maxTurns: 50 })).toEqual([]);
    expect(errorsOf({ ...prompt, maxTurns: 0 }).join()).toContain("maxTurns must be");
    expect(errorsOf(withChange({ maxTurns: 50 }))).toEqual(["Only a prompt schedule has maxTurns"]);
    expect(errorsOf(withChange({ permissionMode: "yolo" })).join()).toContain("permissionMode");
    expect(errorsOf(withChange({ name: "" })).join()).toContain("name must be");
  });
});

const source = (over: Partial<TemplateSource> = {}): TemplateSource => ({
  name: "GitHub to ntfy",
  description: "Pushes GitHub notifications to an ntfy topic.",
  kind: "script",
  mode: "tick",
  cron_expr: "0 * * * * *",
  prompt: "",
  script: scriptTemplate.script,
  inputs: scriptTemplate.inputs as TemplateSource["inputs"],
  inputValues: {},
  timeout_ms: 600_000,
  max_turns: null,
  permission_mode: "bypassPermissions",
  ...over,
});

describe("templateFromSchedule", () => {
  it("round-trips: export, import, export again gives the same file", () => {
    const first = templateFromSchedule(source()).template;
    expect(first).toEqual(scriptTemplate as never);
    const parsed = parseScheduleTemplate(serializeScheduleTemplate(first));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(serializeScheduleTemplate(parsed.template)).toBe(serializeScheduleTemplate(first));
  });

  it("current values become defaults, but never a secret's and never a machine path", () => {
    const { template, warnings } = templateFromSchedule(source({
      inputs: [
        ...scriptTemplate.inputs as TemplateSource["inputs"],
        { key: "notesDir", label: "Notes", type: "text", default: "support-triage" },
      ],
      inputValues: { server: "https://ntfy.example.com", pollSeconds: 30, dryRun: false, notesDir: "/home/me/notes" },
    }));
    const byKey = Object.fromEntries((template.inputs ?? []).map((i) => [i.key, i]));
    expect(byKey.server!.default).toBe("https://ntfy.example.com");
    expect(byKey.pollSeconds!.default).toBe(30);
    expect(byKey.dryRun!.default).toBe(false);
    expect(byKey.notesDir!.default).toBe("support-triage");
    expect("default" in byKey.token!).toBe(false);
    expect(warnings).toEqual(['The value of "notesDir" is a path on this machine, so it was left out']);
  });

  it("names each line of the script that mentions a path of this machine", () => {
    const { warnings } = templateFromSchedule(source({ script: "const a = 1;\nconst dir = '/home/me/work/x';\n" }), ["/home/me"]);
    expect(warnings).toEqual(["Line 2 mentions /home/me, which only exists on this machine"]);
  });

  it("a prompt schedule exports its prompt, an always-on one no cron or timeout", () => {
    const prompt = templateFromSchedule(source({ kind: "prompt", cron_expr: "0 9 * * *", prompt: "Summarise", script: null })).template;
    expect(prompt.prompt).toBe("Summarise");
    expect(prompt.script).toBeUndefined();
    expect(prompt.inputs).toBeUndefined();
    const daemon = templateFromSchedule(source({ mode: "always-on", cron_expr: "" })).template;
    expect(daemon.cron).toBeUndefined();
    expect(daemon.timeoutMs).toBeUndefined();
    expect(parseScheduleTemplate(daemon).ok).toBe(true);
  });
});

describe("scheduleTemplateFileName", () => {
  it("is a plain slug with the template suffix", () => {
    expect(scheduleTemplateFileName("Báo cáo đơn hàng!")).toBe("bao-cao-don-hang.ppm-schedule.json");
    expect(scheduleTemplateFileName("***")).toBe("schedule.ppm-schedule.json");
  });
});
