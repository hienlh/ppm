/** One script tick, end to end on a real process: what it keeps, and what it does not. */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import "../../../test-setup.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerRegistry } from "../../../../src/providers/registry.ts";
import { configService } from "../../../../src/services/config.service.ts";
import { deleteSchedule, getSchedule, insertSchedule, listScheduleRuns } from "../../../../src/services/scheduler-db.service.ts";
import { encryptSecrets } from "../../../../src/services/schedule-script/schedule-secrets.ts";
import { removeRunDir } from "../../../../src/services/schedule-script/script-files.ts";
import { runScriptTick } from "../../../../src/services/schedule-script/tick-runner.ts";
import type { ScheduleInputDecl } from "../../../../src/types/scheduler.ts";

let projectDir = "";
let previousProjects: unknown;
const made: number[] = [];

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), "ppm-tick-"));
  previousProjects = configService.get("projects");
  configService.set("projects", [{ name: "demo", path: projectDir }]);
});
afterAll(() => {
  configService.set("projects", previousProjects as never);
  rmSync(projectDir, { recursive: true, force: true });
});
afterEach(() => {
  for (const id of made.splice(0)) removeRunDir(id);
});

const TOKEN = "xoxp-1234567890-very-secret";
const inputs: ScheduleInputDecl[] = [
  { key: "channel", label: "Channel", type: "text", default: "#support" },
  { key: "token", label: "Slack token", type: "secret", required: true },
];

function schedule(script: string, fields: { timeout_ms?: number; secrets?: Record<string, string>; state?: string } = {}) {
  const id = insertSchedule({
    name: "tick", cron_expr: "*/5 * * * * *", provider_id: "mock", project_path: projectDir, prompt: "",
    kind: "script", mode: "tick", script, timeout_ms: fields.timeout_ms ?? 60_000,
    inputs_json: JSON.stringify(inputs), input_values_json: "{}",
    secrets_enc: encryptSecrets(fields.secrets ?? { token: TOKEN }),
  });
  made.push(id);
  return getSchedule(id)!;
}

describe("runScriptTick", () => {
  it("keeps no run row for a quiet tick, but keeps its state", async () => {
    const s = schedule("export default async (ctx) => { ctx.state.seen = (ctx.state.seen ?? 0) + 1; }");
    await runScriptTick(s);
    await runScriptTick(getSchedule(s.id)!);
    expect(listScheduleRuns(s.id)).toEqual([]);
    expect(getSchedule(s.id)!.state_json).toBe('{"seen":2}');
  });

  it("keeps a row for a tick that logged, with its output, its cost, and every secret masked", async () => {
    const mock = providerRegistry.get("mock") as unknown as { completeOnce: (...a: unknown[]) => Promise<unknown> };
    const ask = spyOn(mock, "completeOnce").mockResolvedValue({ text: "fine", costUsd: 0.25, inputTokens: 0, outputTokens: 0 });
    try {
      const s = schedule(`export default async (ctx) => {
        await ctx.ai.ask("hi");
        ctx.log("posting to", ctx.inputs.channel, "with", ctx.inputs.token);
      }`);
      await runScriptTick(s);
      const [run] = listScheduleRuns(s.id);
      expect(run).toMatchObject({ status: "done", error: null, cost_usd: 0.25, output_truncated: "posting to #support with ••••\n" });
      expect(run!.ended_at).not.toBeNull();
    } finally {
      ask.mockRestore();
    }
  });

  it("keeps the state after a failed tick too, and the error with its secrets masked", async () => {
    const s = schedule(`export default async (ctx) => {
      ctx.state.done = ["NX-1"];
      throw new Error("Slack refused " + ctx.inputs.token);
    }`);
    await runScriptTick(s);
    const [run] = listScheduleRuns(s.id);
    expect(run!.status).toBe("error");
    expect(run!.error).toStartWith("Error: Slack refused ••••");
    expect(run!.error).not.toContain(TOKEN);
    expect(getSchedule(s.id)!.state_json).toBe('{"done":["NX-1"]}');
  });

  it("stops a tick that runs past its timeout", async () => {
    const s = schedule("export default async (ctx) => { console.log('waiting'); await ctx.sleep(60_000); }", { timeout_ms: 1500 });
    const started = Date.now();
    await runScriptTick(s);
    expect(Date.now() - started).toBeLessThan(5000);
    const [run] = listScheduleRuns(s.id);
    expect(run!.status).toBe("error");
    expect(run!.error).toContain("it ran past its timeout of 2 s");
  });

  it("reports a state over 2 MB as the tick's error and keeps the previous one", async () => {
    const s = schedule(`export default async (ctx) => {
      if (!ctx.state.small) { ctx.state.small = true; return; }
      ctx.state.big = "x".repeat(3 * 1024 * 1024);
    }`);
    await runScriptTick(s);
    await runScriptTick(getSchedule(s.id)!);
    const [run] = listScheduleRuns(s.id);
    expect(run!.error).toStartWith("ctx.state was not saved: ctx.state is 3.0 MB");
    expect(getSchedule(s.id)!.state_json).toBe('{"small":true}');
  });

  it("records nothing for a schedule deleted while its tick ran", async () => {
    const s = schedule("export default async (ctx) => { ctx.log('working'); await ctx.sleep(300); }");
    const tick = runScriptTick(s);
    await Bun.sleep(100);
    deleteSchedule(s.id);
    await expect(tick).resolves.toBeUndefined();
    expect(listScheduleRuns(s.id)).toEqual([]);
  });

  it("does not start a schedule whose required input is empty", async () => {
    const s = schedule("export default async () => {}", { secrets: {} });
    await runScriptTick(s);
    const [run] = listScheduleRuns(s.id);
    expect(run).toMatchObject({ status: "error", error: "Fill in token before it can run" });
  });
});
