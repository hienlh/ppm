/**
 * The handed-off work checker (plan decision 11). One unref'd timer for every project ticks each
 * minute; a task is looked at when its project's interval has passed since its last check, or
 * sooner when a decision falls due. A look is one `liveState` call, one positioned read of what the
 * child's transcript gained, and a listing of its subagents' transcripts — the child is never sent
 * anything: no turn, no answer to a card.
 *
 * Findings worth telling (stalled, finished without a result; see the classifier's backoff) are
 * gathered per project and told in one unattended wake of its manager chat. When the manager cannot
 * be woken — none, or its wake budget is spent — one Assistant card says the same instead (its phone
 * copy waits out quiet hours). A busy manager is asked again each tick, and after 15 tries the card
 * goes out instead.
 */
import { createLogger } from "../../logger.ts";
import { getDb, resolveMigratedSession } from "../../db.service.ts";
import { projectNameForPath } from "../../project-name-for-path.ts";
import { listTasksNeedingCheck } from "../ppm-tasks-read.ts";
import { getTaskProject } from "../ppm-tasks-projects.service.ts";
import { managerSessionFor } from "../ppm-tasks-write.ts";
import type { ChildCheckState, TaskView } from "../../../shared/ppm-tasks.ts";
import { formatTaskRef } from "../../../shared/ppm-tasks-refs.ts";
import { checkDue, classifyChildCheck, shouldAlert, type CheckMemory } from "./child-check-classifier.ts";
import { judgeProgress, parseRecentForms, readAppended } from "./transcript-progress-reader.ts";
import { cardText, quotableLines, wakeLines, type Finding } from "./child-check-findings.ts";
import { liveChildCheckEnv, type ChildCheckEnv } from "./child-check-env.ts";

export type { ChildCheckEnv } from "./child-check-env.ts";

const log = createLogger("ppm-tasks");
export const CHECK_TICK_MS = 60_000;
/** Ticks a finding waits for a busy manager before it goes out as a card instead. */
export const MAX_BUSY_TRIES = 15;

interface CheckRow {
  task_id: string; session_id: string; state: ChildCheckState; checked_at: number; last_progress_at: number | null;
  transcript_offset: number | null; recent_forms_json: string | null; alerts: number; last_alert_at: number | null; last_alert_state: ChildCheckState | null;
}

const toMemory = (r: CheckRow): CheckMemory => ({
  state: r.state, checkedAt: r.checked_at, lastProgressAt: r.last_progress_at,
  alerts: r.alerts, lastAlertAt: r.last_alert_at, lastAlertState: r.last_alert_state,
});

const projectNameOf = (projectKey: string): string => {
  const path = getTaskProject(projectKey)?.projectPath ?? projectKey;
  return projectNameForPath(path) ?? path.split(/[\\/]/).pop() ?? projectKey;
};

const maxOrNull = (...values: Array<number | null | undefined>): number | null => {
  const known = values.filter((v): v is number => typeof v === "number");
  return known.length ? Math.max(...known) : null;
};

export function createChildCheckRunner(env: ChildCheckEnv = liveChildCheckEnv) {
  /** Findings not told yet because the manager was busy: tries so far and the lines to quote. */
  const retry = new Map<string, { tries: number; quoted: string[] }>();
  let ticking = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  /** Looks at one task's child; stores what it saw and returns a finding when one is due. */
  async function checkOne(task: TaskView, row: CheckRow | null, now: number, intervalMs: number): Promise<{ finding: Finding | null; moved: boolean }> {
    const id = task.workingSessionId!;
    const handedOffAt = task.handedOffAt!;
    const exists = env.sessionExists(id);
    const live = exists ? env.liveState(id) : null;
    const providerId = env.providerOf(id);
    const where = exists ? await env.locate(id, providerId, intervalMs) : null;
    const read = where ? readAppended(where.path, row?.transcript_offset ?? 0, providerId, handedOffAt) : null;
    const subagents = where?.subagentsDir ? await env.subagentActivity(where.subagentsDir) : null;
    const judged = judgeProgress(read?.lines ?? [], parseRecentForms(row?.recent_forms_json ?? null), now, 3 * intervalMs);
    // Work the main transcript does not show: a subagent writing since the last look (it counts as
    // progress whatever it wrote), or a record of a kind the reader does not know.
    const subagentProgress = subagents !== null && subagents > (row?.checked_at ?? handedOffAt) ? subagents : null;
    const progressAt = maxOrNull(judged.progressAt, read?.unknown ? now : null, subagentProgress);
    const lastProgressAt = maxOrNull(row?.last_progress_at, progressAt);
    const verdict = classifyChildCheck({
      exists, card: !!live?.card, running: !!live?.running, lastProgressAt,
      lastActivityAt: maxOrNull(read?.mtimeMs, subagents), handedOffAt, now, intervalMs,
    });
    getDb().query(
      `INSERT INTO task_child_checks (task_id, session_id, state, checked_at, last_progress_at, transcript_offset, recent_forms_json, alerts, last_alert_at, last_alert_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (task_id) DO UPDATE SET session_id = excluded.session_id, state = excluded.state, checked_at = excluded.checked_at,
         last_progress_at = excluded.last_progress_at, transcript_offset = excluded.transcript_offset, recent_forms_json = excluded.recent_forms_json`,
    ).run(task.id, id, verdict.state, now, lastProgressAt, read?.offset ?? row?.transcript_offset ?? null, JSON.stringify(judged.recent),
      row?.alerts ?? 0, row?.last_alert_at ?? null, row?.last_alert_state ?? null);
    const memory = { alerts: row?.alerts ?? 0, lastAlertAt: row?.last_alert_at ?? null, lastAlertState: row?.last_alert_state ?? null };
    let finding: Finding | null = null;
    if (shouldAlert(verdict, memory, now, intervalMs)) {
      const fresh = quotableLines(read?.lines ?? []);
      finding = {
        task, sessionId: id, chatTitle: env.chatTitle(id), state: verdict.state, reason: verdict.reason, since: verdict.since,
        // A retry's read starts after the lines the first try saw: quote those again.
        quoted: fresh.length ? fresh : retry.get(task.id)?.quoted ?? [],
      };
    } else {
      retry.delete(task.id); // nothing to tell any more (progress resumed, or a card came up)
    }
    return { finding, moved: row?.state !== verdict.state };
  }

  function recordAlerts(findings: readonly Finding[], now: number): void {
    const q = getDb().query("UPDATE task_child_checks SET alerts = alerts + 1, last_alert_at = ?, last_alert_state = ? WHERE task_id = ?");
    for (const f of findings) { q.run(now, f.state, f.task.id); retry.delete(f.task.id); }
  }

  function card(projectKey: string, projectName: string, findings: Finding[], now: number, why: string, manager: string | null): void {
    const { title, body } = cardText(findings, projectName, now, why);
    const tasks = findings.map((f) => ({ taskId: f.task.id, sessionId: f.sessionId, ref: formatTaskRef(f.task.number, projectName) }));
    env.postCard(projectKey, projectName, manager, title, body, tasks);
    recordAlerts(findings, now);
  }

  async function tell(projectKey: string, findings: Finding[], now: number): Promise<void> {
    const projectName = projectNameOf(projectKey);
    const tries = Math.max(...findings.map((f) => retry.get(f.task.id)?.tries ?? 0));
    if (tries >= MAX_BUSY_TRIES) {
      return card(projectKey, projectName, findings, now, `The manager chat has been busy for ${tries} minutes, so PPM did not wake it.`, managerSessionFor(projectKey));
    }
    const outcome = await env.wake(projectKey, wakeLines(findings, projectName, now));
    if (outcome.ok) return recordAlerts(findings, now);
    if (outcome.reason === "budget") return card(projectKey, projectName, findings, now, "PPM did not wake the manager: its send budget is used up for now.", managerSessionFor(projectKey));
    if (outcome.reason === "no_session") return card(projectKey, projectName, findings, now, "This project has no manager chat to look into it.", null);
    // Busy, or the wake failed: nothing was told; ask again at the next tick.
    for (const f of findings) retry.set(f.task.id, { tries: (retry.get(f.task.id)?.tries ?? 0) + 1, quoted: f.quoted });
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const now = env.now();
      const db = getDb();
      const needing = listTasksNeedingCheck();
      const rows = new Map<string, CheckRow>((db.query("SELECT * FROM task_child_checks").all() as CheckRow[]).map((r) => [r.task_id, r]));
      const wanted = new Set(needing.map((n) => n.task.id));
      // A result, a close, a delete or a return to the manager ends the checks: the row goes.
      for (const taskId of rows.keys()) if (!wanted.has(taskId)) { db.query("DELETE FROM task_child_checks WHERE task_id = ?").run(taskId); retry.delete(taskId); }
      for (const taskId of retry.keys()) if (!wanted.has(taskId)) retry.delete(taskId);
      const findings = new Map<string, Finding[]>();
      const moved = new Set<string>();
      for (const { task, intervalMin } of needing) {
        if (!task.workingSessionId || task.handedOffAt === null) continue;
        const intervalMs = intervalMin * 60_000;
        let row = rows.get(task.id) ?? null;
        if (row && resolveMigratedSession(row.session_id) !== task.workingSessionId) {
          // Handed to another chat: a new hand-off, its own alert count.
          db.query("DELETE FROM task_child_checks WHERE task_id = ?").run(task.id);
          retry.delete(task.id);
          row = null;
        }
        if (!retry.has(task.id) && !checkDue(row ? toMemory(row) : null, task.handedOffAt, now, intervalMs)) continue;
        try {
          const { finding, moved: m } = await checkOne(task, row, now, intervalMs);
          if (m) moved.add(task.projectKey);
          if (finding) findings.set(task.projectKey, [...(findings.get(task.projectKey) ?? []), finding]);
        } catch (e) {
          log.warn(`check of task ${task.id} failed: ${(e as Error).message}`);
        }
      }
      for (const [projectKey, list] of findings) {
        try { await tell(projectKey, list, now); } catch (e) { log.warn(`telling the manager of ${projectKey} failed: ${(e as Error).message}`); }
      }
      if (moved.size) env.emit([...moved]);
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    start(): void {
      if (timer) return;
      timer = setInterval(() => { void tick().catch((e) => log.warn(`task checks failed: ${(e as Error).message}`)); }, CHECK_TICK_MS);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export type ChildCheckRunner = ReturnType<typeof createChildCheckRunner>;
