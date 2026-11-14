import { readFileSync } from "node:fs";
import type { Command } from "commander";
import type { Schedule, ScheduleView } from "../../types/scheduler.ts";
import { inAiChat } from "../../services/ai-chat-env.ts";
import { noteDirectWrite } from "../utils/ppm-server-client.ts";
import { C, fail, serverApi, ServerDownError } from "./schedule-cmd-api.ts";

/**
 * How `ppm schedule add|edit|rm|enable|disable` write: through `/api/schedules` on the running PPM
 * that holds the database — the route Settings → Schedules and the Assistant's tools call, so its
 * checks apply, its scheduler re-arms, and every open Schedules panel refreshes on
 * `schedules:changed` — and, only when no PPM holds it, to the database after the notice, with the
 * route's own rules (`scheduler-edit.ts`; `session-schedule-save.ts` for one delivered into a chat,
 * whose per-chat cap and checks hold here too).
 *
 * `add`, `edit` and `enable` are refused from an AI chat: a schedule runs prompts or scripts in
 * turns nobody started, and the Assistant's `schedule_save` shows the user a card for exactly
 * that. Advisory, like every check keyed on the AI-chat mark; the shell's card is the control.
 */

type Deps = { configService: typeof import("../../services/config.service.ts").configService; db: typeof import("../../services/scheduler-db.service.ts") };

export function refuseScheduleWriteInAiChat(command: string): void {
  if (!inAiChat()) return;
  fail(`ppm schedule ${command} is refused here from an AI chat: a schedule runs prompts or scripts in turns nobody started. `
    + "Use the Assistant's schedule_save tool (it shows the user a card), session_schedule_create to schedule a prompt "
    + "into your own chat, or give the user the command.");
}

/** The route's write, or `direct` after the notice when no PPM holds the database. Any other failure ends the command. */
export async function scheduleWrite<T>(method: string, path: string, body: unknown, direct: () => T | Promise<T>): Promise<T> {
  try {
    return await serverApi<T>(method, path, body);
  } catch (e) {
    if (!(e instanceof ServerDownError)) return fail((e as Error).message);
  }
  try {
    await noteDirectWrite();
    return await direct();
  } catch (e) {
    return fail((e as Error).message);
  }
}

/** A project given by name or path, as its path. */
async function projectPathOf(nameOrPath: string): Promise<string> {
  const { getProjects } = await import("../../services/db.service.ts");
  const project = getProjects().find((p) => p.name === nameOrPath || p.path === nameOrPath);
  return project ? project.path : fail(`Project not found: ${nameOrPath}`);
}

function readScript(file: string): string {
  try { return readFileSync(file, "utf8"); } catch { return fail(`Cannot read ${file}`); }
}

const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));

interface EditOpts {
  name?: string; description?: string; cron?: string; project?: string; prompt?: string; script?: string; mode?: string;
  permissionMode?: string; maxTurns?: string; timeout?: string;
}

/** The PATCH body of `edit`: only what was given. */
export function editBody(opts: EditOpts, projectPath?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: opts.name, description: opts.description, cron_expr: opts.cron, project_path: projectPath, prompt: opts.prompt,
    script: opts.script === undefined ? undefined : readScript(opts.script), mode: opts.mode,
    permission_mode: opts.permissionMode, max_turns: num(opts.maxTurns), timeout_ms: num(opts.timeout),
  };
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
}

/** `edit` flags a schedule delivered into a chat has no use for: it runs on that chat's settings. */
const NOT_FOR_SESSION: ReadonlyArray<[keyof EditOpts, string, string]> = [
  ["project", "--project", "project_path"],
  ["permissionMode", "--permission-mode", "permission_mode"],
  ["maxTurns", "--max-turns", "max_turns"],
  ["timeout", "--timeout", "timeout_ms"],
];

/**
 * The `edit` body for a schedule delivered into a chat, without the flags that do not apply to
 * one, and those flags by name so the command can say it did not use them.
 */
export function sessionEditBody(opts: EditOpts, body: Record<string, unknown>): { body: Record<string, unknown>; ignored: string[] } {
  const kept = { ...body };
  const ignored: string[] = [];
  for (const [opt, flag, field] of NOT_FOR_SESSION) {
    if (opts[opt] === undefined) continue;
    ignored.push(flag);
    delete kept[field];
  }
  return { body: kept, ignored };
}

interface SessionAddOpts {
  session: string; name?: string; cron?: string; prompt?: string; tz?: string; once?: boolean; disabled?: boolean;
  project?: string; script?: string; maxTurns?: string; timeout?: string;
}

/** The POST body of `add --session`: the chat decides the project, provider and mode. */
export function sessionAddBody(opts: SessionAddOpts): Record<string, unknown> {
  if (opts.project || opts.script || opts.maxTurns || opts.timeout) {
    fail("--project, --script, --max-turns and --timeout do not apply with --session: the schedule runs in that chat, on its settings");
  }
  if (!opts.prompt || !opts.cron) fail("--prompt and --cron are required with --session");
  return {
    kind: "session", target_session_id: opts.session, cron_expr: opts.cron, prompt: opts.prompt, recurring: !opts.once,
    enabled: !opts.disabled, ...(opts.name && { name: opts.name }), ...(opts.tz && { timezone: opts.tz }),
  };
}

/** `add --session`: checked by the server, or with no server by the same rules here (`session-schedule-save.ts`). */
async function addSessionSchedule(opts: SessionAddOpts, db: Deps["db"]): Promise<void> {
  const body = sessionAddBody(opts);
  const created = await scheduleWrite<Pick<ScheduleView, "id" | "target_session_id" | "next_fire_at">>("POST", "/schedules", body, async () => {
    const { createSessionSchedule } = await import("../../services/session-schedules/session-schedule-save.ts");
    return db.getSchedule(createSessionSchedule(body).id)!;
  });
  const next = created.next_fire_at ? `, next fire: ${created.next_fire_at}` : "";
  console.log(`${C.green}✓${C.reset} Schedule ${C.bold}#${created.id}${C.reset} created (into chat ${created.target_session_id}${next})`);
}

/** The direct write of a PATCH body, by the rules the route applies to that kind of schedule. */
export async function directPatch(db: Deps["db"], current: Schedule, body: Record<string, unknown>): Promise<void> {
  if (current.kind === "session") {
    const { patchSessionSchedule } = await import("../../services/session-schedules/session-schedule-save.ts");
    patchSessionSchedule(current, body);
    return;
  }
  const { scheduleChangesFrom } = await import("../../services/scheduler-edit.ts");
  db.updateSchedule(current.id, scheduleChangesFrom(current, body));
}

export function registerScheduleWriteCommands(schedule: Command, loadDeps: () => Promise<Deps>): void {
  schedule
    .command("add")
    .description("Add a scheduled agent (--prompt), a script schedule (--script), or a prompt delivered into an existing chat (--session). Cron uses local timezone unless --tz. Do not embed secrets in --prompt. Refused from an AI chat (use schedule_save).")
    .option("--name <name>", "Schedule name (required, except with --session: the prompt's first line by default)")
    .option("--cron <expr>", "Cron expression (local timezone, e.g. \"0 7 * * *\"; a script may add seconds first)")
    .option("--project <nameOrPath>", "Project name or path (required, except with --session: the chat's own)")
    .option("--session <id>", "Deliver --prompt into this existing chat, once it is idle, instead of a chat of the schedule's own")
    .option("--tz <zone>", "With --session: IANA time zone the cron is read in, e.g. Europe/London")
    .option("--once", "With --session: fire once at the next match, then delete itself")
    .option("--prompt <text>", "Prompt sent to the agent each run")
    .option("--script <file>", "JavaScript module run each tick, or kept running")
    .option("--mode <mode>", "Script mode: tick (on the cron) or always-on", "tick")
    .option("--permission-mode <mode>", "Permission mode", "bypassPermissions")
    .option("--max-turns <n>", "Max turns per run (prompt only)")
    .option("--timeout <ms>", "Timeout per run in ms (default 1800000 for a prompt, 300000 for a script tick)")
    .option("--disabled", "Create disabled")
    .action(async (opts) => {
      refuseScheduleWriteInAiChat("add");
      const { configService, db } = await loadDeps();
      if (opts.session) return addSessionSchedule(opts, db);
      if (opts.tz || opts.once) fail("--tz and --once are for a schedule delivered into a chat (--session)");
      if (!opts.name || !opts.project) fail("--name and --project are required (or --session to deliver into an existing chat)");
      const projectPath = await projectPathOf(opts.project);
      let body: Record<string, unknown>;
      if (opts.script) {
        if (opts.prompt || opts.maxTurns) fail("--prompt and --max-turns are for a prompt schedule, not --script");
        body = { kind: "script", mode: opts.mode, script: readScript(opts.script), ...(opts.cron && { cron_expr: opts.cron }) };
      } else {
        if (!opts.prompt || !opts.cron) fail("--prompt and --cron are required (or --script for a script schedule)");
        if (opts.mode !== "tick") fail("A prompt schedule runs on its cron; --mode is for --script");
        body = { kind: "prompt", cron_expr: opts.cron, prompt: opts.prompt, ...(opts.maxTurns && { max_turns: Number(opts.maxTurns) }) };
      }
      Object.assign(body, { name: opts.name, project_path: projectPath, permission_mode: opts.permissionMode, enabled: !opts.disabled },
        opts.timeout ? { timeout_ms: Number(opts.timeout) } : {});
      // A view from the server, the row when written here: only these fields are read either way.
      const created = await scheduleWrite<Pick<ScheduleView, "id" | "kind" | "mode" | "next_fire_at">>("POST", "/schedules", body, async () => {
        const { newScheduleFrom } = await import("../../services/scheduler-edit.ts");
        return db.getSchedule(db.insertSchedule(newScheduleFrom(body, configService.get("ai").default_provider)))!;
      });
      const next = created.next_fire_at ? `, next fire: ${created.next_fire_at}` : "";
      console.log(`${C.green}✓${C.reset} Schedule ${C.bold}#${created.id}${C.reset} created (${created.kind === "script" ? created.mode : "prompt"}${next})`);
    });

  schedule
    .command("edit <id>")
    .description("Change a schedule: only the options given change. Refused from an AI chat (use schedule_save).")
    .option("--name <name>", "Schedule name")
    .option("--description <text>", "Description")
    .option("--cron <expr>", "Cron expression (local timezone)")
    .option("--project <nameOrPath>", "Project name or path")
    .option("--prompt <text>", "Prompt sent to the agent each run (prompt schedules)")
    .option("--script <file>", "The script to run from now on (script schedules)")
    .option("--mode <mode>", "Script mode: tick or always-on")
    .option("--permission-mode <mode>", "Permission mode")
    .option("--max-turns <n>", "Max turns per run (prompt only)")
    .option("--timeout <ms>", "Timeout per run in ms")
    .action(async (id: string, opts: EditOpts) => {
      refuseScheduleWriteInAiChat("edit");
      const { db } = await loadDeps();
      const current = db.getSchedule(Number(id));
      if (!current) fail(`Schedule not found: ${id}`);
      let body = editBody(opts, opts.project && current!.kind !== "session" ? await projectPathOf(opts.project) : undefined);
      if (current!.kind === "session") {
        const checked = sessionEditBody(opts, body);
        body = checked.body;
        if (checked.ignored.length) {
          console.error(`${C.yellow}!${C.reset} Ignored ${checked.ignored.join(", ")}: schedule #${id} runs in its chat, on that chat's settings`);
        }
      }
      if (!Object.keys(body).length) fail("Nothing to change; pass at least one option (see --help)");
      await scheduleWrite("PATCH", `/schedules/${id}`, body, () => directPatch(db, current!, body));
      console.log(`${C.green}✓${C.reset} Schedule #${id} updated`);
    });
}
