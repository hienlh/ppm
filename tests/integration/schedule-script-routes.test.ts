/**
 * The script half of /api/schedules: no answer carries a secret or the state, an import needs
 * trust and lands turned off, a script cannot be turned on with a required input empty, and a
 * delete waits for the process before the row goes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configService } from "../../src/services/config.service.ts";
import { openTestDb, setDb } from "../../src/services/db.service.ts";

const stopCalls: Array<{ id: number; enabledThen: number | null }> = [];
mock.module("../../src/services/scheduler.service.ts", () => ({
  schedulerService: { runJobNow: () => ({ runId: null, wasRunning: false }), rearm: () => {}, isRunning: () => false },
  alwaysOnSupervisor: {
    status: () => null,
    // What the row looked like when the process was told to stop.
    stop: async (id: number) => { stopCalls.push({ id, enabledThen: db.getSchedule(id)?.enabled ?? null }); },
  },
}));

const { schedulesRoutes } = await import("../../src/server/routes/schedules.ts");
const db = await import("../../src/services/scheduler-db.service.ts");
const { saveState } = await import("../../src/services/schedule-script/ctx-state.ts");
const { logRing } = await import("../../src/services/schedule-script/script-log.ts");
const { readSecrets } = await import("../../src/services/schedule-script/schedule-secrets.ts");
const guard = await import("../../src/services/schedule-script/instance-guard.ts");

const SECRET = "xoxp-route-secret-0123456789";
const inputs = [
  { key: "channel", label: "Channel", type: "text", default: "#support" },
  { key: "token", label: "Slack token", type: "secret", required: true },
  { key: "notes", label: "Notes dir", type: "text" },
];
const template = {
  ppmScheduleTemplate: 1, name: "Support bot", kind: "script", mode: "always-on",
  script: "export default async (ctx) => { ctx.log('hi'); }", inputs,
};

let projectDir = "";
let previousProjects: unknown;
beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), "ppm-sched-routes-"));
  previousProjects = configService.get("projects");
  configService.set("projects", [{ name: "demo", path: projectDir }]);
});
afterAll(() => {
  configService.set("projects", previousProjects as never);
  rmSync(projectDir, { recursive: true, force: true });
});
beforeEach(() => {
  setDb(openTestDb());
  stopCalls.length = 0;
});

const send = async (method: string, path: string, body?: unknown) => {
  const res = await schedulesRoutes.request(path, {
    method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as { ok: boolean; data: any; error?: string; problems?: string[] } };
};

const scriptBody = (over: Record<string, unknown> = {}) => ({
  name: "script", kind: "script", mode: "tick", cron_expr: "*/30 * * * * *", project_path: projectDir,
  script: "export default async () => {}", inputs, inputValues: { notes: join(projectDir, "notes") },
  secrets: { token: SECRET }, enabled: false, ...over,
});

async function create(over: Record<string, unknown> = {}): Promise<number> {
  const res = await send("POST", "/", scriptBody(over));
  expect(res.status).toBe(201);
  return res.json.data.id;
}

describe("schedule script routes", () => {
  it("no answer carries a secret, its ciphertext, or the raw state", async () => {
    const created = await send("POST", "/", scriptBody());
    const id = created.json.data.id as number;
    saveState(id, JSON.stringify({ token: SECRET, seen: [1] }));
    const ciphertext = db.getSchedule(id)!.secrets_enc!;
    const answers = [
      created,
      await send("PATCH", `/${id}`, { name: "renamed" }),
      await send("GET", "/"),
      await send("GET", `/${id}`),
      await send("GET", `/${id}/export`),
      await send("GET", `/${id}/state`),
      await send("GET", `/${id}/logs`),
    ];
    for (const answer of answers) {
      expect(answer.status).toBeLessThan(300);
      for (const leak of [SECRET, ciphertext, '"secrets_enc"', '"state_json"']) expect(answer.text).not.toContain(leak);
    }
    expect(answers[3]!.json.data).toMatchObject({ secretsSet: ["token"], inputValues: { notes: join(projectDir, "notes") } });
    expect(answers[5]!.json.data.state).toBe('{\n  "token": "••••",\n  "seen": [\n    1\n  ]\n}');
  });

  it("an export has no secret, no path of this machine, no state or session, and says what it left out", async () => {
    const id = await create({ script: `const dir = "${projectDir}/x";\nexport default async () => {};\n` });
    saveState(id, JSON.stringify({ seen: [1] }));
    const { json } = await send("GET", `/${id}/export`);
    const { template: exported, fileName, warnings } = json.data;
    expect(fileName).toBe("script.ppm-schedule.json");
    expect(Object.keys(exported)).not.toContain("state");
    const byKey = Object.fromEntries(exported.inputs.map((i: { key: string }) => [i.key, i]));
    expect("default" in byKey.token).toBe(false);
    expect("default" in byKey.notes).toBe(false);
    expect(warnings).toEqual([
      'The value of "notes" is a path on this machine, so it was left out',
      `Line 1 mentions ${projectDir}, which only exists on this machine`,
    ]);
  });

  it("an import needs trust: true, is strict, and is always created turned off", async () => {
    const body = { template, projectName: "demo", secrets: { token: SECRET } };
    expect((await send("POST", "/import", body)).status).toBe(400);
    expect((await send("POST", "/import", { ...body, trust: "yes" })).status).toBe(400);
    expect((await send("GET", "/")).json.data).toEqual([]);

    const strict = await send("POST", "/import", { ...body, trust: true, template: { ...template, enabled: true } });
    expect(strict.status).toBe(400);
    expect(strict.json.problems).toEqual(['Unknown field "enabled"']);
    expect((await send("POST", "/import", { ...body, trust: true, projectName: "nope" })).status).toBe(400);

    const imported = await send("POST", "/import", { ...body, trust: true });
    expect(imported.status).toBe(201);
    expect(imported.json.data).toMatchObject({ enabled: 0, kind: "script", mode: "always-on", project_path: projectDir, secretsSet: ["token"], next_fire_at: null });
  });

  it("turning a script on with a required input empty is a 409 that names the input", async () => {
    const imported = await send("POST", "/import", { template, projectName: "demo", trust: true });
    const id = imported.json.data.id as number;
    const refused = await send("PATCH", `/${id}`, { enabled: true });
    expect(refused.status).toBe(409);
    expect(refused.json.problems).toEqual(["Fill in token before turning it on"]);
    expect(db.getSchedule(id)!.enabled).toBe(0);

    expect((await send("PATCH", `/${id}`, { enabled: true, secrets: { token: SECRET } })).status).toBe(200);
    expect((await send("PATCH", `/${id}`, { secrets: { token: null } })).status).toBe(409);
    expect((await send("POST", "/", scriptBody({ secrets: {}, enabled: true }))).status).toBe(409);
  });

  it("a secret sent as null is cleared, one left out is kept, and a save that changes nothing rewrites nothing", async () => {
    const id = await create({ inputValues: { notes: "triage", channel: "#ops" } });
    // Values saved in another order than the declarations, as after the inputs were reordered.
    db.updateSchedule(id, { input_values_json: '{"notes":"triage","channel":"#ops"}' });
    const before = db.getSchedule(id)!;
    const reordered = inputs.map(({ key, label, type, ...rest }) => ({ type, ...rest, label, key, required: rest.required ?? false }));
    await send("PATCH", `/${id}`, { ...scriptBody({ inputs: reordered, inputValues: { channel: "#ops", notes: "triage" } }), secrets: undefined });
    const after = db.getSchedule(id)!;
    expect([after.secrets_enc, after.inputs_json, after.input_values_json]).toEqual([before.secrets_enc, before.inputs_json, before.input_values_json]);

    await send("PATCH", `/${id}`, { secrets: { token: "xoxp-another-value-42" } });
    expect(readSecrets(db.getSchedule(id)!)).toEqual({ token: "xoxp-another-value-42" });
    const cleared = await send("PATCH", `/${id}`, { secrets: { token: null }, inputValues: { notes: null } });
    expect(cleared.json.data).toMatchObject({ secretsSet: [], inputValues: { channel: "#ops" } });
  });

  it("the state is replaced only while the schedule is off and its process gone", async () => {
    const id = await create({ enabled: true });
    expect((await send("PUT", `/${id}/state`, { state: { a: 1 } })).status).toBe(409);
    await send("PATCH", `/${id}`, { enabled: false });
    const live = spyOn(guard, "liveScript").mockReturnValue({ pid: 1 } as never);
    try {
      expect((await send("PUT", `/${id}/state`, { state: { a: 1 } })).status).toBe(409);
    } finally {
      live.mockRestore();
    }
    expect((await send("PUT", `/${id}/state`, { state: { a: 1 } })).json.data.state).toBe('{\n  "a": 1\n}');
    expect((await send("PUT", `/${id}/state`, { state: { token: "••••" } })).status).toBe(400);
    expect((await send("PUT", `/${id}/state`, {})).status).toBe(400);
    expect((await send("PUT", `/${id}/state`, { state: null })).json.data.state).toBeNull();
  });

  it("a delete turns the schedule off and waits for its process before the row goes", async () => {
    const id = await create({ mode: "always-on", cron_expr: undefined, enabled: true });
    expect((await send("DELETE", `/${id}`)).status).toBe(200);
    expect(stopCalls).toEqual([{ id, enabledThen: 0 }]);
    expect(db.getSchedule(id)).toBeNull();
  });

  it("logs answer the lines after a sequence number, with the process status", async () => {
    const id = await create();
    logRing(id).push("one");
    logRing(id).push("two");
    const { json } = await send("GET", `/${id}/logs?after=1`);
    expect(json.data).toMatchObject({ last: 2, status: { state: "idle" } });
    expect(json.data.lines.map((l: { text: string }) => l.text)).toEqual(["two"]);
  });

  it("refuses a kind change, a timeout on an always-on script, and a mode change while a tick runs", async () => {
    const id = await create();
    expect((await send("PATCH", `/${id}`, { kind: "prompt" })).status).toBe(400);
    expect((await send("POST", "/", scriptBody({ mode: "always-on", cron_expr: undefined, timeout_ms: 60_000 }))).json.problems)
      .toEqual(["An always-on schedule has no run timeout"]);
    const live = spyOn(guard, "liveScript").mockReturnValue({ pid: 1 } as never);
    try {
      expect((await send("PATCH", `/${id}`, { mode: "always-on", cron_expr: "" })).status).toBe(409);
    } finally {
      live.mockRestore();
    }
    const switched = await send("PATCH", `/${id}`, { mode: "always-on" });
    expect(switched.json.data).toMatchObject({ mode: "always-on", cron_expr: "", next_fire_at: null });
  });
});
