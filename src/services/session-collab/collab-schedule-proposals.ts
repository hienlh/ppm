/**
 * `session_schedule_propose_script` and `session_schedule_set_enabled`: a chat's AI proposes a
 * script schedule for its own project, and pauses or turns on schedules, without deleting them.
 *
 * Reach, as for the other schedule tools: the chat is the one the token names. Its own reminders
 * (session schedules aimed at this chat) are paused and turned on unasked, as they are created and
 * deleted unasked. A script or prompt schedule must run in this chat's project folder: pausing one
 * is done at once (it only stops something), turning one on goes through a card in this chat. A
 * schedule elsewhere reads exactly like one that does not exist. Every change is logged. A script schedule is created only from a card the user allowed, from the very
 * proposal the card was built from, and only in this chat's project folder.
 */
import { textResult, type Json } from "../mcp-http-endpoint.ts";
import { createLogger } from "../logger.ts";
import { isUnattendedTurn } from "../chat-control/chat-control.ts";
import type { SessionCollabScheduleApproval } from "../../shared/session-collab.ts";
import type { Schedule } from "../../types/scheduler.ts";
import { getSchedule } from "../scheduler-db.service.ts";
import { ScheduleEditError } from "../scheduler-edit.ts";
import { SessionScheduleRefusal, sessionScheduleTargetIds } from "../session-schedules/session-schedule-lifecycle.ts";
import { resolveScheduleTarget, type ScheduleTarget, type ScheduleTargetDeps } from "../session-schedules/session-schedule-target.ts";
import { projectOfFolder, unchangedSince } from "../assistant-mcp/assistant-schedule-shape.ts";
import type { CollabApprovalOutcome } from "./collab-approval-broker.ts";
import { parseScriptProposal, type ScriptScheduleProposal } from "../schedule-proposals/script-proposal.ts";
import { scriptProposalSummary, type ProposalCardDeps } from "../schedule-proposals/script-proposal-card.ts";
import { proposalStaleReason, type ProposalCreate } from "../schedule-proposals/script-proposal-create.ts";
import { scheduleToggleSummary } from "../schedule-proposals/schedule-toggle.ts";

export interface ScheduleProposalToolEnv {
  target: ScheduleTargetDeps;
  /** Shows the card in the chat and waits for the user's answer (`collabApprovalBroker.request`). */
  ask(sessionId: string, input: SessionCollabScheduleApproval, signal?: AbortSignal): Promise<CollabApprovalOutcome>;
  /** The provider a new schedule is snapshotted to (the default one, read now). */
  providerId(): string;
  card(): ProposalCardDeps;
  /** Saves the approved proposal; `createdBy` is the proposing chat, whose footer chip then lists it. */
  create(p: ScriptScheduleProposal, providerId: string, createdBy: string): ProposalCreate;
  setEnabled(current: Schedule, enabled: boolean): Schedule;
  /** A schedule changed: re-arm the scheduler and refresh open schedule lists. */
  changed(): void;
  /** Whether PPM started the chat's running turn with nobody in it (`isUnattendedTurn`). */
  unattended(sessionId: string): boolean;
}

/** Every schedule change a chat's AI makes goes into PPM's log (the Logs window), beside the session trace's record of the call. */
const log = createLogger("scheduler");

const json = (value: unknown, isError = false): Json => textResult(JSON.stringify(value, null, 1), isError);
const fail = (message: string): Json => textResult(message, true);

function notAllowed(outcome: Exclude<CollabApprovalOutcome, { allowed: true }>, what: string): Json {
  return json({ done: false, outcome: outcome.reason, note: `${outcome.message} ${what}` }, true);
}

function refusalText(e: unknown): string {
  if (e instanceof ScheduleEditError) return `Not changed: ${e.problems.join("; ")}.`;
  if (e instanceof SessionScheduleRefusal) return `Not changed: ${e.message}`;
  return `Not changed: ${(e as Error).message}`;
}

/** What the AI reads back about a schedule it created or changed. */
function view(s: Schedule) {
  return {
    id: s.id, name: s.name, kind: s.kind, mode: s.mode, cron: s.cron_expr, timeZone: s.timezone,
    folder: s.project_path, enabled: s.enabled === 1, nextFire: s.next_fire_at,
  };
}

export async function proposeScriptTool(env: ScheduleProposalToolEnv, chat: ScheduleTarget, args: Record<string, unknown>, signal?: AbortSignal): Promise<Json> {
  const project = { name: chat.projectName, path: chat.projectPath };
  const providerId = env.providerId();
  const parsed = parseScriptProposal(args, project, providerId, [chat.projectPath]);
  if (!parsed.ok) return fail(parsed.error);
  const proposal = parsed.proposal;
  const card: SessionCollabScheduleApproval = {
    kind: "schedule", action: "create_script", summary: scriptProposalSummary(proposal, providerId, env.card()),
  };
  const outcome = await env.ask(chat.sessionId, card, signal);
  if (!outcome.allowed) return notAllowed(outcome, "No schedule was created.");

  const stale = proposalStaleReason(proposal, providerId, env.providerId());
  if (stale) return json({ done: false, outcome: "stale", note: `${stale} Nothing was created; propose it again if it is still wanted.` }, true);
  const created = env.create(proposal, providerId, chat.sessionId);
  if (!created.ok) return fail(created.error);
  env.changed();
  log.info(`chat ${chat.sessionId} created script schedule #${created.schedule.id} "${created.schedule.name}" in project "${chat.projectName}" after the user allowed its card`);
  return json({
    created: true, schedule: view(created.schedule),
    note: "The user allowed it. It runs at its next fire; its log is in Settings → Schedules. Pause it with "
      + "session_schedule_set_enabled, never by deleting and creating it again.",
  });
}

/** The schedule `id` if this chat may toggle it, and whether that needs a card. */
function reachable(id: number, chat: ScheduleTarget, env: ScheduleProposalToolEnv): { schedule: Schedule; ownReminder: boolean } | null {
  const s = getSchedule(id);
  if (!s) return null;
  if (s.kind === "session") {
    return sessionScheduleTargetIds(chat.sessionId, env.target).includes(s.target_session_id ?? "") ? { schedule: s, ownReminder: true } : null;
  }
  return projectOfFolder(s.project_path, [{ name: chat.projectName, path: chat.projectPath }]) ? { schedule: s, ownReminder: false } : null;
}

export async function setEnabledTool(env: ScheduleProposalToolEnv, chat: ScheduleTarget, args: Record<string, unknown>, signal?: AbortSignal): Promise<Json> {
  const id = typeof args.id === "number" ? args.id : typeof args.id === "string" && /^\d+$/.test(args.id) ? Number(args.id) : NaN;
  if (!Number.isSafeInteger(id) || id < 1) return fail("`id` must be a schedule id from session_schedule_list.");
  if (typeof args.enabled !== "boolean") return fail("`enabled` must be true (turn it on) or false (pause it).");
  const enabled = args.enabled;
  const found = reachable(id, chat, env);
  // Out of reach reads exactly like missing: its id says nothing here.
  if (!found) return fail(`This chat has no schedule with id ${id} it may change; see session_schedule_list.`);
  const seen = found.schedule;
  if ((seen.enabled === 1) === enabled) return fail(`Schedule ${id} is already ${enabled ? "on" : "paused"}; nothing to do.`);

  // Pausing only stops something, so it needs no card; turning one of the project's schedules on
  // starts it again and does. The chat's own reminders change unasked either way, as before. A turn
  // PPM started with nobody in it (a script's message, a watch report) still changes none of the
  // project's schedules unasked: it goes through the card, which such a turn cannot show.
  const asked = !found.ownReminder && (enabled || env.unattended(chat.sessionId));
  if (asked) {
    const card: SessionCollabScheduleApproval = {
      kind: "schedule", action: enabled ? "enable" : "disable",
      summary: scheduleToggleSummary(seen, enabled, chat.projectName, env.card()),
    };
    const outcome = await env.ask(chat.sessionId, card, signal);
    if (!outcome.allowed) return notAllowed(outcome, "The schedule was not changed.");
    const now = getSchedule(id);
    if (!now || !unchangedSince(seen, now)) {
      return json({ done: false, outcome: "stale", note: `Schedule ${id} changed (or went) while the card waited. Nothing was done; read it again with session_schedule_list.` }, true);
    }
  }
  let saved: Schedule;
  try {
    saved = env.setEnabled(seen, enabled);
  } catch (e) {
    return fail(refusalText(e));
  }
  env.changed();
  const what = `schedule #${saved.id} "${saved.name}" (${saved.kind}${saved.mode === "always-on" ? ", always on" : ""}) in project "${chat.projectName}"`;
  log.info(`chat ${chat.sessionId} ${enabled ? "turned on" : "paused"} ${what}${asked ? " after the user allowed its card" : " (no card needed)"}`);
  const resume = found.ownReminder ? "until it is turned on again" : "until it is turned on again, which the user approves on a card";
  return json({
    updated: true,
    [enabled ? "turnedOn" : "paused"]: { id: saved.id, name: saved.name, kind: saved.kind, project: chat.projectName },
    schedule: view(saved),
    note: enabled
      ? `Turned on ${what}. It runs again from its next fire.`
      : `Paused ${what}${asked ? "" : " without asking: pausing needs no card"}. Tell the user. It will not run ${resume}.`,
  });
}

/** The live environment: the session tools' card broker, the route's save functions. */
export async function liveScheduleProposalToolEnv(): Promise<ScheduleProposalToolEnv> {
  const [{ collabApprovalBroker }, { configService }, create, toggle, { liveScheduleTargetDeps }, { announceSchedulesChanged }] = await Promise.all([
    import("./collab-approval-broker.ts"),
    import("../config.service.ts"),
    import("../schedule-proposals/script-proposal-create.ts"),
    import("../schedule-proposals/schedule-toggle.ts"),
    import("../session-schedules/session-schedule-target.ts"),
    import("../session-schedules/session-schedules-changed.ts"),
  ]);
  return {
    target: liveScheduleTargetDeps,
    ask: (sessionId, input, signal) => collabApprovalBroker.request(sessionId, input, signal),
    providerId: () => String(configService.get("ai")?.default_provider ?? "claude"),
    card: create.liveProposalCardDeps,
    create: create.createProposedSchedule,
    setEnabled: toggle.setScheduleEnabled,
    changed: announceSchedulesChanged,
    unattended: isUnattendedTurn,
  };
}

/** Resolves the token's chat, then runs one of the two tools. */
export async function scheduleProposalToolCall(
  env: ScheduleProposalToolEnv, tokenSessionId: string, tool: "propose" | "set_enabled", rawArgs: unknown, signal?: AbortSignal,
): Promise<Json> {
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs as Record<string, unknown> : {};
  const chat = resolveScheduleTarget(tokenSessionId, env.target);
  if (!chat.ok) return fail(`This chat cannot manage schedules: ${chat.reason}`);
  return tool === "propose" ? proposeScriptTool(env, chat.target, args, signal) : setEnabledTool(env, chat.target, args, signal);
}
