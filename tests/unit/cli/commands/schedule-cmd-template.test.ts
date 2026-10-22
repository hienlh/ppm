/**
 * `ppm schedule import|export|state` against a real server on a random port: a secret read
 * from a file reaches the schedule, `export -o` writes the template, and no output — success or
 * error — ever shows a secret's value.
 */
import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { Hono } from "hono";
import { configService } from "../../../../src/services/config.service.ts";
import { openTestDb, setDb } from "../../../../src/services/db.service.ts";

mock.module("../../../../src/services/scheduler.service.ts", () => ({
  schedulerService: { runJobNow: () => ({ runId: null, wasRunning: false }), rearm: () => {}, isRunning: () => false },
  alwaysOnSupervisor: { status: () => null, stop: async () => {} },
}));

const { schedulesRoutes } = await import("../../../../src/server/routes/schedules.ts");
const { importBody, registerScheduleTemplateCommands } = await import("../../../../src/cli/commands/schedule-cmd-template.ts");
const db = await import("../../../../src/services/scheduler-db.service.ts");
const { readSecrets } = await import("../../../../src/services/schedule-script/schedule-secrets.ts");
const { saveState } = await import("../../../../src/services/schedule-script/ctx-state.ts");

const SECRET = "xoxp-cli-secret-9876543210";
/** A JSON parser quotes an identifier it stops at in full, and this one is all identifier. */
const GH_TOKEN = "ghp_cliSecret0123456789abcdef";
const template = {
  ppmScheduleTemplate: 1, name: "Notify", kind: "script", mode: "tick", cron: "0 * * * * *",
  script: "export default async () => {}",
  inputs: [
    { key: "topic", label: "Topic", type: "text", default: "alerts" },
    { key: "poll", label: "Poll seconds", type: "number" },
    { key: "dryRun", label: "Dry run", type: "boolean", default: true },
    { key: "token", label: "Token", type: "secret", required: true },
  ],
};

let dir = "";
let server: ReturnType<typeof Bun.serve>;
let saved: { port: unknown; projects: unknown };
const output: string[] = [];

beforeAll(() => {
  setDb(openTestDb());
  dir = mkdtempSync(join(tmpdir(), "ppm-sched-cli-"));
  writeFileSync(join(dir, "t.ppm-schedule.json"), JSON.stringify(template));
  writeFileSync(join(dir, "token.txt"), `${SECRET}\n`);
  writeFileSync(join(dir, "gh.txt"), `${GH_TOKEN}\n`);
  const app = new Hono().route("/api/schedules", schedulesRoutes);
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  saved = { port: configService.get("port"), projects: configService.get("projects") };
  configService.set("port", server.port as never);
  configService.set("projects", [{ name: "demo", path: dir }]);
});
afterAll(() => {
  server.stop(true);
  configService.set("port", saved.port as never);
  configService.set("projects", saved.projects as never);
  rmSync(dir, { recursive: true, force: true });
});
/** Runs `ppm schedule …args`; a fail() is an "exit 1" error instead of the end of the test run. */
async function ppm(...args: string[]): Promise<void> {
  const record = (...parts: unknown[]) => { output.push(parts.join(" ")); };
  const spies = [
    spyOn(console, "log").mockImplementation(record),
    spyOn(console, "error").mockImplementation(record),
    spyOn(process.stdout, "write").mockImplementation(((text: string) => { output.push(text); return true; }) as never),
    spyOn(process, "exit").mockImplementation(((code: number) => { throw new Error(`exit ${code}`); }) as never),
  ];
  try {
    const program = new Command().exitOverride();
    registerScheduleTemplateCommands(program.command("schedule"), async () => {});
    await program.parseAsync(["bun", "ppm", "schedule", ...args]);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

describe("importBody", () => {
  const file = () => join(dir, "t.ppm-schedule.json");

  it("reads a secret from @file, and types each --set value as its input declares", () => {
    const body = importBody(file(), { project: "demo", set: ["poll=30", "dryRun=no", "topic=a=b"], secret: [`token=@${join(dir, "token.txt")}`], trust: true });
    expect(body).toMatchObject({ projectName: "demo", trust: true, inputValues: { poll: 30, dryRun: false, topic: "a=b" }, secrets: { token: SECRET } });
  });

  it("refuses what it cannot use, without quoting a value back", () => {
    const attempts: Array<[string[], string[], string]> = [
      [[], [SECRET], "--secret takes key=value"],
      [[], [`nope=${SECRET}`], 'The template has no secret input named "nope"'],
      [[`token=${SECRET}`], [], '"token" is a secret; pass it with --secret'],
      [["poll=lots"], [], '"poll" must be a number'],
      [[], ["token=@/nonexistent/token"], 'Cannot read the file for the secret "token": ENOENT'],
    ];
    for (const [set, secret, message] of attempts) {
      let thrown = "";
      try {
        importBody(file(), { project: "demo", set, secret });
      } catch (e) {
        thrown = (e as Error).message;
      }
      expect(thrown).toBe(message);
    }
    expect(() => importBody(join(dir, "token.txt"), { project: "demo", set: [], secret: [] })).toThrow("is not a template PPM can import");
  });
});

describe("ppm schedule import / export / state", () => {
  it("imports turned off with the secret from the file, exports with -o, and never prints the secret", async () => {
    await expect(ppm("import", join(dir, "t.ppm-schedule.json"), "--project", "demo", "--secret", `token=@${join(dir, "token.txt")}`)).rejects.toThrow("exit 1");
    expect(db.getSchedules()).toEqual([]);

    await ppm("import", join(dir, "t.ppm-schedule.json"), "--project", "demo", "--set", "poll=15", "--secret", `token=@${join(dir, "token.txt")}`, "--trust");
    const [created] = db.getSchedules();
    expect(created).toMatchObject({ enabled: 0, project_path: dir, input_values_json: '{"poll":15}' });
    expect(readSecrets(created!)).toEqual({ token: SECRET });
    saveState(created!.id, JSON.stringify({ lastToken: SECRET }));

    const out = join(dir, "out.ppm-schedule.json");
    await ppm("export", String(created!.id), "-o", out);
    const exported = JSON.parse(readFileSync(out, "utf8"));
    expect(exported.inputs.find((i: { key: string }) => i.key === "poll").default).toBe(15);
    expect(exported.inputs.find((i: { key: string }) => i.key === "token")).toEqual({ key: "token", label: "Token", type: "secret", required: true });
    await ppm("export", String(created!.id));
    await ppm("state", String(created!.id));
    await expect(ppm("set-state", String(created!.id), join(dir, "gh.txt"))).rejects.toThrow("exit 1");

    const printed = output.join("\n");
    expect(printed).toContain('"lastToken": "••••"');
    expect(printed).toContain(`${join(dir, "gh.txt")} is not valid JSON`);
    expect(printed).not.toContain(SECRET);
    expect(printed).not.toContain(GH_TOKEN);
  });
});
