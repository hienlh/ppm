/**
 * A chat's `session_schedule_propose_script` and `session_schedule_set_enabled` against the real
 * card broker and a test database: nothing is created or changed until the card is allowed, what
 * is created is what the card showed, a file that changed while the card waited creates nothing,
 * and a schedule of another project or chat reads exactly like one that does not exist.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { getSchedule, getSchedules, insertSchedule } from "../../../src/services/scheduler-db.service.ts";
import { createCollabApprovalBroker } from "../../../src/services/session-collab/collab-approval-broker.ts";
import {
  scheduleProposalToolCall, type ScheduleProposalToolEnv,
} from "../../../src/services/session-collab/collab-schedule-proposals.ts";
import { createProposedSchedule } from "../../../src/services/schedule-proposals/script-proposal-create.ts";
import { setScheduleEnabled } from "../../../src/services/schedule-proposals/schedule-toggle.ts";
import type { ScheduleTargetDeps } from "../../../src/services/session-schedules/session-schedule-target.ts";
import type { SessionCollabApprovalRequest, SessionCollabScheduleApproval } from "../../../src/shared/session-collab.ts";

const CHAT = "chat-proposer-1";
const OTHER_CHAT = "chat-proposer-2";
const SCRIPT = "export default async function main(ctx) { ctx.log(\"tick\"); }\n";
let root: string, projectPath: string, otherPath: string;
let cards: SessionCollabApprovalRequest[];
let provider: string;
let changes: number;

const broker = createCollabApprovalBroker({
  chat: () => ({ announce: (_s, event) => { cards.push(event); return true; }, resolved: () => {} }),
});

const target: ScheduleTargetDeps = {
  canonical: (id) => id,
  stored: (id, read) => read(id),
  isDesign: () => false,
  isAssistant: () => false,
  hasClaudeTranscript: () => false,
  projectByPath: (p) => (p === projectPath ? { name: "proj", path: projectPath } : p === otherPath ? { name: "other", path: otherPath } : null),
  projectPath: (id) => (id === CHAT ? projectPath : id === OTHER_CHAT ? otherPath : null),
  provider: () => "claude",
};

const env: ScheduleProposalToolEnv = {
  target,
  ask: (sessionId, input: SessionCollabScheduleApproval, signal) => broker.request(sessionId, input, signal),
  providerId: () => provider,
  card: () => ({ nextRuns: (_c, _z, n) => Array.from({ length: n }, (_, i) => `run ${i + 1}`), machineZone: "Asia/Saigon", chat: () => null }),
  create: createProposedSchedule,
  setEnabled: setScheduleEnabled,
  changed: () => { changes++; },
};

type Result = { content: Array<{ text: string }>; isError?: boolean };
const text = (r: unknown) => (r as Result).content[0]!.text;
const propose = (args: Record<string, unknown>, session = CHAT) => scheduleProposalToolCall(env, session, "propose", args) as Promise<Result>;
const toggle = (args: Record<string, unknown>, session = CHAT) => scheduleProposalToolCall(env, session, "set_enabled", args) as Promise<Result>;

/** Waits for the card the pending call shows, then answers it. */
async function answer(choice: "allow_once" | "deny"): Promise<SessionCollabApprovalRequest> {
  for (let i = 0; i < 50 && cards.length === 0; i++) await Bun.sleep(5);
  const card = cards.at(-1)!;
  expect(broker.answer(card.requestId, { answer: choice })).toMatchObject({ ok: true });
  return card;
}

const fields = { name: "Watch", cron: "0 */5 * * * *", script: SCRIPT, timezone: "Europe/London", permissionMode: "default" };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-proposal-tools-"));
  projectPath = join(root, "proj");
  otherPath = join(root, "other");
  mkdirSync(projectPath, { recursive: true });
  mkdirSync(otherPath, { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  setDb(openTestDb());
  cards = [];
  provider = "claude";
  changes = 0;
});

describe("session_schedule_propose_script", () => {
  it("creates nothing until the card is allowed, then exactly what the card showed, on", async () => {
    const call = propose(fields);
    const card = await answer("allow_once");
    expect(card.input).toMatchObject({ kind: "schedule", action: "create_script" });
    const shown = (card.input as SessionCollabScheduleApproval).summary;
    expect(shown.body!.text).toBe(SCRIPT);
    expect(shown.reviewInPpm).toBeTruthy();
    const res = await call;
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(text(res));
    const row = getSchedule(out.schedule.id)!;
    expect(row).toMatchObject({ kind: "script", script: SCRIPT, project_path: projectPath, timezone: "Europe/London", enabled: 1, cron_expr: "0 */5 * * * *", permission_mode: "default" });
    expect(changes).toBe(1);
  });

  it("creates nothing when the user denies", async () => {
    const call = propose(fields);
    await answer("deny");
    const res = await call;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("No schedule was created");
    expect(getSchedules()).toHaveLength(0);
  });

  it("creates nothing when its file changed while the card waited", async () => {
    const file = join(projectPath, "watch.ppm-schedule.json");
    const template = { ppmScheduleTemplate: 1, name: "From file", kind: "script", mode: "tick", cron: "0 */5 * * * *", script: SCRIPT };
    writeFileSync(file, JSON.stringify(template));
    const call = propose({ file });
    for (let i = 0; i < 50 && cards.length === 0; i++) await Bun.sleep(5);
    writeFileSync(file, JSON.stringify({ ...template, script: "export default async () => { /* something else */ }" }));
    await answer("allow_once");
    const res = await call;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("stale");
    expect(getSchedules()).toHaveLength(0);
  });

  it("creates nothing when the default provider changed while the card waited", async () => {
    const call = propose(fields);
    for (let i = 0; i < 50 && cards.length === 0; i++) await Bun.sleep(5);
    provider = "codex";
    await answer("allow_once");
    expect(text(await call)).toContain("default provider changed");
    expect(getSchedules()).toHaveLength(0);
  });

  it("runs only in the chat's own project: a file elsewhere is refused before any card", async () => {
    const file = join(otherPath, "x.ppm-schedule.json");
    writeFileSync(file, JSON.stringify({ ppmScheduleTemplate: 1, name: "x", kind: "script", mode: "tick", cron: "0 */5 * * * *", script: SCRIPT }));
    const res = await propose({ file });
    expect(res.isError).toBe(true);
    expect(cards).toHaveLength(0);
  });
});

describe("session_schedule_set_enabled", () => {
  const script = (path: string) => insertSchedule({
    name: "Existing", cron_expr: "0 */5 * * * *", provider_id: "claude", project_path: path, prompt: "", kind: "script",
    script: SCRIPT, permission_mode: "default", timeout_ms: 300_000, enabled: true,
  });
  const reminder = (session: string, path: string) => insertSchedule({
    name: "Remind", cron_expr: "0 9 * * *", provider_id: "claude", project_path: path, prompt: "check", kind: "session",
    target_session_id: session, enabled: true,
  });

  it("pauses and turns on the chat's own reminder at once, with no card", async () => {
    const id = reminder(CHAT, projectPath);
    expect(JSON.parse(text(await toggle({ id, enabled: false }))).schedule.enabled).toBe(false);
    expect(getSchedule(id)!.enabled).toBe(0);
    expect(JSON.parse(text(await toggle({ id, enabled: true }))).schedule.enabled).toBe(true);
    expect(cards).toHaveLength(0);
  });

  it("pauses a script of its project only after the card is allowed, and not when denied", async () => {
    const id = script(projectPath);
    const denied = toggle({ id, enabled: false });
    await answer("deny");
    expect((await denied).isError).toBe(true);
    expect(getSchedule(id)!.enabled).toBe(1);

    const allowed = toggle({ id, enabled: false });
    const card = await answer("allow_once");
    expect(card.input).toMatchObject({ kind: "schedule", action: "disable" });
    expect((await allowed).isError).toBeFalsy();
    expect(getSchedule(id)!.enabled).toBe(0);

    // Turning a script back on shows the script and is allowed only in PPM.
    const on = toggle({ id, enabled: true });
    const onCard = (await answer("allow_once")).input as SessionCollabScheduleApproval;
    expect(onCard.summary.body!.text).toBe(SCRIPT);
    expect(onCard.summary.reviewInPpm).toBeTruthy();
    expect((await on).isError).toBeFalsy();
    expect(getSchedule(id)!.enabled).toBe(1);
  });

  it("reads another project's schedule and another chat's reminder as missing", async () => {
    for (const id of [script(otherPath), reminder(OTHER_CHAT, otherPath), reminder(OTHER_CHAT, projectPath), 9999]) {
      const res = await toggle({ id, enabled: false });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain(`no schedule with id ${id}`);
    }
    expect(cards).toHaveLength(0);
  });

  it("does nothing when the schedule changed while the card waited", async () => {
    const id = script(projectPath);
    const call = toggle({ id, enabled: false });
    for (let i = 0; i < 50 && cards.length === 0; i++) await Bun.sleep(5);
    const { updateSchedule } = await import("../../../src/services/scheduler-db.service.ts");
    updateSchedule(id, { script: `${SCRIPT}// edited` });
    await answer("allow_once");
    expect(text(await call)).toContain("stale");
    expect(getSchedule(id)!.enabled).toBe(1);
  });
});
