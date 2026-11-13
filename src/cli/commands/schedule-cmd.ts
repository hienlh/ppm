/**
 * `ppm schedule` CLI — manage scheduled Claude agents (cron) and script schedules. Every write goes
 * through the running PPM's `/api/schedules` (`schedule-cmd-write.ts`); reads come from the
 * database, with what a process is doing asked of the server.
 */
import { Command } from "commander";
import type { ScheduleView } from "../../types/scheduler.ts";
import { api, C, fail, serverApi, statusText } from "./schedule-cmd-api.ts";
import { registerScheduleTemplateCommands } from "./schedule-cmd-template.ts";
import { refuseScheduleWriteInAiChat, registerScheduleWriteCommands, scheduleWrite } from "./schedule-cmd-write.ts";

async function loadDeps() {
  const { configService } = await import("../../services/config.service.ts");
  if (!configService.isLoaded) configService.load();
  const db = await import("../../services/scheduler-db.service.ts");
  return { configService, db };
}

export function registerScheduleCommands(program: Command): void {
  const schedule = program.command("schedule").description("Scheduled Claude agents (cron) and script schedules");

  registerScheduleWriteCommands(schedule, loadDeps);

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
      await scheduleWrite("DELETE", `/schedules/${id}`, undefined, async () => {
        db.deleteSchedule(Number(id));
        if (s!.kind === "script") (await import("../../services/schedule-script/script-files.ts")).removeRunDir(Number(id));
      });
      console.log(`${C.green}✓${C.reset} Schedule #${id} deleted`);
    });

  for (const action of ["enable", "disable"] as const) {
    schedule
      .command(`${action} <id>`)
      .description(action === "enable" ? "Enable a schedule. Refused from an AI chat (use schedule_save)." : "Disable a schedule")
      .action(async (id: string) => {
        const enabling = action === "enable";
        if (enabling) refuseScheduleWriteInAiChat("enable");
        const { db } = await loadDeps();
        const s = db.getSchedule(Number(id));
        if (!s) fail(`Schedule not found: ${id}`);
        await scheduleWrite("PATCH", `/schedules/${id}`, { enabled: enabling }, async () => {
          // The route's rules: turning one on works out its next fire, and refuses a script missing inputs.
          const { scheduleChangesFrom } = await import("../../services/scheduler-edit.ts");
          db.updateSchedule(Number(id), scheduleChangesFrom(s!, { enabled: enabling }));
        });
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
