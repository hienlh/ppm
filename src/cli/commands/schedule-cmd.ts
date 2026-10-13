/** `ppm schedule` CLI — manage scheduled Claude agents (cron) and script schedules. */
import { readFileSync } from "node:fs";
import { Command } from "commander";
import type { ScheduleView } from "../../types/scheduler.ts";
import { api, C, fail, serverApi, ServerDownError, statusText } from "./schedule-cmd-api.ts";
import { registerScheduleTemplateCommands } from "./schedule-cmd-template.ts";

async function loadDeps() {
  const { configService } = await import("../../services/config.service.ts");
  configService.load();
  const db = await import("../../services/scheduler-db.service.ts");
  return { configService, db };
}

/**
 * A script schedule's process is the server's: a change to one goes through the server, which
 * starts or stops it. With no server running there is no process, and the database will do.
 */
async function viaServer(kind: string, method: string, path: string, body?: unknown): Promise<boolean> {
  if (kind !== "script") return false;
  try {
    await serverApi(method, path, body);
    return true;
  } catch (e) {
    if (e instanceof ServerDownError) return false;
    return fail((e as Error).message);
  }
}

export function registerScheduleCommands(program: Command): void {
  const schedule = program.command("schedule").description("Scheduled Claude agents (cron) and script schedules");

  schedule
    .command("add")
    .description("Add a scheduled agent (--prompt) or a script schedule (--script). Cron uses local timezone. Do not embed secrets in --prompt.")
    .requiredOption("--name <name>", "Schedule name")
    .option("--cron <expr>", "Cron expression (local timezone, e.g. \"0 7 * * *\"; a script may add seconds first)")
    .requiredOption("--project <nameOrPath>", "Project name or path")
    .option("--prompt <text>", "Prompt sent to the agent each run")
    .option("--script <file>", "JavaScript module run each tick, or kept running (needs a running PPM server)")
    .option("--mode <mode>", "Script mode: tick (on the cron) or always-on", "tick")
    .option("--permission-mode <mode>", "Permission mode", "bypassPermissions")
    .option("--max-turns <n>", "Max turns per run (prompt only)")
    .option("--timeout <ms>", "Timeout per run in ms (default 1800000 for a prompt, 300000 for a script tick)")
    .option("--disabled", "Create disabled")
    .action(async (opts) => {
      try {
        const { configService, db } = await loadDeps();
        const { getProjects } = await import("../../services/db.service.ts");
        const project = getProjects().find((p) => p.name === opts.project || p.path === opts.project);
        if (!project) fail(`Project not found: ${opts.project}`);

        if (opts.script) {
          if (opts.prompt || opts.maxTurns) fail("--prompt and --max-turns are for a prompt schedule, not --script");
          let script = "";
          try { script = readFileSync(opts.script, "utf8"); } catch { fail(`Cannot read ${opts.script}`); }
          const created = await api<ScheduleView>("POST", "/schedules", {
            name: opts.name, kind: "script", mode: opts.mode, project_path: project!.path, script,
            permission_mode: opts.permissionMode, enabled: !opts.disabled,
            ...(opts.cron && { cron_expr: opts.cron }),
            ...(opts.timeout && { timeout_ms: Number(opts.timeout) }),
          });
          console.log(`${C.green}✓${C.reset} Schedule ${C.bold}#${created.id}${C.reset} created (${opts.mode}${created.next_fire_at ? `, next fire: ${created.next_fire_at}` : ""})`);
          return;
        }
        if (!opts.prompt || !opts.cron) fail("--prompt and --cron are required (or --script for a script schedule)");
        if (opts.mode !== "tick") fail("A prompt schedule runs on its cron; --mode is for --script");
        const { Cron } = await import("croner");
        try { new Cron(opts.cron); } catch (e) { fail(`Invalid cron: ${(e as Error).message}`); }

        const id = db.insertSchedule({
          name: opts.name,
          cron_expr: opts.cron,
          provider_id: configService.get("ai").default_provider,
          project_path: project!.path,
          prompt: opts.prompt,
          permission_mode: opts.permissionMode,
          max_turns: opts.maxTurns ? Number(opts.maxTurns) : null,
          timeout_ms: Number(opts.timeout) || 1_800_000,
          enabled: !opts.disabled,
          next_fire_at: new Cron(opts.cron).nextRun()?.toISOString() ?? null,
        });
        console.log(`${C.green}✓${C.reset} Schedule ${C.bold}#${id}${C.reset} created (next fire: ${db.getSchedule(id)?.next_fire_at ?? "—"})`);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    });

  schedule
    .command("list")
    .description("List schedules")
    .option("--enabled-only", "Only enabled schedules")
    .action(async (opts) => {
      const { db } = await loadDeps();
      const rows = db.getSchedules(!!opts.enabledOnly);
      if (rows.length === 0) { console.log(`${C.dim}No schedules.${C.reset}`); return; }
      // What the processes are doing is only known to the server; without one, the list says less.
      const live = await serverApi<ScheduleView[]>("GET", "/schedules").then((views) => new Map(views.map((v) => [v.id, v.status])), () => null);
      for (const s of rows) {
        const status = s.enabled ? `${C.green}enabled${C.reset}` : `${C.dim}disabled${C.reset}`;
        const lastRun = db.listScheduleRuns(s.id, 1)[0];
        const last = lastRun ? `last: ${lastRun.status}` : "never run";
        const kind = s.kind === "script" ? `script/${s.mode}` : "prompt";
        const when = s.mode === "always-on" ? "" : `  ${C.cyan}${s.cron_expr}${C.reset}  next: ${s.next_fire_at ?? "—"}`;
        const state = live?.get(s.id);
        const doing = state ? statusText(state) : "";
        console.log(`${C.bold}#${s.id}${C.reset} ${s.name}  ${kind}${when}  ${status}${doing ? `  ${doing}` : ""}  ${C.dim}${last} · ${s.project_path}${C.reset}`);
      }
    });

  schedule
    .command("rm <id>")
    .description("Delete a schedule (cascades run history)")
    .option("-y, --yes", "Skip confirmation")
    .action(async (id: string, opts: { yes?: boolean }) => {
      const { db } = await loadDeps();
      const s = db.getSchedule(Number(id));
      if (!s) fail(`Schedule not found: ${id}`);
      if (!opts.yes) {
        const { confirm } = await import("@inquirer/prompts");
        if (!(await confirm({ message: `Delete schedule #${id} "${s!.name}" and its run history?` }))) return;
      }
      if (!(await viaServer(s!.kind, "DELETE", `/schedules/${id}`))) {
        db.deleteSchedule(Number(id));
        if (s!.kind === "script") (await import("../../services/schedule-script/script-files.ts")).removeRunDir(Number(id));
      }
      console.log(`${C.green}✓${C.reset} Schedule #${id} deleted`);
    });

  for (const action of ["enable", "disable"] as const) {
    schedule
      .command(`${action} <id>`)
      .description(`${action[0]!.toUpperCase()}${action.slice(1)} a schedule`)
      .action(async (id: string) => {
        const { db } = await loadDeps();
        const s = db.getSchedule(Number(id));
        if (!s) fail(`Schedule not found: ${id}`);
        const enabling = action === "enable";
        if (!(await viaServer(s!.kind, "PATCH", `/schedules/${id}`, { enabled: enabling }))) {
          const { Cron } = await import("croner");
          db.updateSchedule(Number(id), {
            enabled: enabling ? 1 : 0,
            // Recompute on enable so it doesn't fire immediately off a stale timestamp
            ...(enabling && s!.mode === "tick" && { next_fire_at: new Cron(s!.cron_expr).nextRun()?.toISOString() ?? null }),
          });
        }
        console.log(`${C.green}✓${C.reset} Schedule #${id} ${action}d`);
      });
  }

  schedule
    .command("run-now <id>")
    .description("Fire a schedule immediately (requires running PPM server)")
    .action(async (id: string) => {
      const { db } = await loadDeps();
      const data = await api<{ runId: number | null; wasRunning: boolean }>("POST", `/schedules/${id}/run-now`);
      // A script tick keeps a run only if it has something to show, so it has no number yet.
      if (data.runId !== null) console.log(`${C.green}✓${C.reset} Run ${C.bold}#${data.runId}${C.reset} started`);
      else console.log(`${C.green}✓${C.reset} Schedule #${id} ${db.getSchedule(Number(id))?.mode === "always-on" ? "restarting" : "tick started"}`);
      if (data.wasRunning && data.runId !== null) {
        console.log(`${C.yellow}⚠${C.reset} A previous run was still active — both now run concurrently`);
      }
    });

  schedule
    .command("runs <id>")
    .description("Show recent runs for a schedule")
    .option("--limit <n>", "Max rows", "20")
    .action(async (id: string, opts: { limit: string }) => {
      const { db } = await loadDeps();
      if (!db.getSchedule(Number(id))) fail(`Schedule not found: ${id}`);
      const runs = db.listScheduleRuns(Number(id), Number(opts.limit) || 20);
      if (runs.length === 0) { console.log(`${C.dim}No runs yet.${C.reset}`); return; }
      for (const r of runs) {
        const color = r.status === "done" ? C.green : r.status === "error" ? C.red : r.status === "running" ? C.yellow : C.dim;
        const cost = r.cost_usd != null ? ` $${r.cost_usd.toFixed(4)}` : "";
        const errHead = r.error ? ` ${C.red}${r.error.slice(0, 80)}${C.reset}` : "";
        console.log(`${C.bold}#${r.id}${C.reset} ${color}${r.status}${C.reset}  ${r.started_at} → ${r.ended_at ?? "…"}${cost}${errHead}`);
      }
    });

  registerScheduleTemplateCommands(schedule, loadDeps);
}
