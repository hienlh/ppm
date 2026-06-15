/** `ppm schedule` CLI — manage scheduled Claude agents (cron). */
import { Command } from "commander";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

const fail = (msg: string): never => {
  console.error(`${C.red}✗${C.reset} ${msg}`);
  process.exit(1);
};

async function loadDeps() {
  const { configService } = await import("../../services/config.service.ts");
  configService.load();
  const db = await import("../../services/scheduler-db.service.ts");
  return { configService, db };
}

export function registerScheduleCommands(program: Command): void {
  const schedule = program.command("schedule").description("Scheduled Claude agents (cron)");

  schedule
    .command("add")
    .description("Add a scheduled agent. Cron uses local timezone. Do not embed secrets in --prompt.")
    .requiredOption("--name <name>", "Schedule name")
    .requiredOption("--cron <expr>", "Cron expression (local timezone, e.g. \"0 7 * * *\")")
    .requiredOption("--project <nameOrPath>", "Project name or path")
    .requiredOption("--prompt <text>", "Prompt sent to the agent each run")
    .option("--permission-mode <mode>", "Permission mode", "bypassPermissions")
    .option("--max-turns <n>", "Max turns per run")
    .option("--timeout <ms>", "Timeout per run in ms", "1800000")
    .option("--disabled", "Create disabled")
    .action(async (opts) => {
      try {
        const { configService, db } = await loadDeps();
        const { Cron } = await import("croner");
        try { new Cron(opts.cron); } catch (e) { fail(`Invalid cron: ${(e as Error).message}`); }

        const { getProjects } = await import("../../services/db.service.ts");
        const project = getProjects().find((p) => p.name === opts.project || p.path === opts.project);
        if (!project) fail(`Project not found: ${opts.project}`);

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
      for (const s of rows) {
        const status = s.enabled ? `${C.green}enabled${C.reset}` : `${C.dim}disabled${C.reset}`;
        const lastRun = db.listScheduleRuns(s.id, 1)[0];
        const last = lastRun ? `last: ${lastRun.status}` : "never run";
        console.log(`${C.bold}#${s.id}${C.reset} ${s.name}  ${C.cyan}${s.cron_expr}${C.reset}  ${status}  next: ${s.next_fire_at ?? "—"}  ${C.dim}${last} · ${s.project_path}${C.reset}`);
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
      db.deleteSchedule(Number(id));
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
        const { Cron } = await import("croner");
        db.updateSchedule(Number(id), {
          enabled: enabling ? 1 : 0,
          // Recompute on enable so it doesn't fire immediately off a stale timestamp
          ...(enabling && { next_fire_at: new Cron(s!.cron_expr).nextRun()?.toISOString() ?? null }),
        });
        console.log(`${C.green}✓${C.reset} Schedule #${id} ${action}d`);
      });
  }

  schedule
    .command("run-now <id>")
    .description("Fire a schedule immediately (requires running PPM server)")
    .action(async (id: string) => {
      const { configService } = await loadDeps();
      const port = configService.get("port");
      const auth = configService.get("auth");
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/schedules/${id}/run-now`, {
          method: "POST",
          headers: auth.enabled ? { Authorization: `Bearer ${auth.token}` } : {},
          signal: AbortSignal.timeout(5000),
        });
        const body = await res.json() as { ok: boolean; data?: { runId: number; wasRunning: boolean }; error?: string };
        if (!body.ok) fail(body.error ?? `HTTP ${res.status}`);
        console.log(`${C.green}✓${C.reset} Run ${C.bold}#${body.data!.runId}${C.reset} started`);
        if (body.data!.wasRunning) {
          console.log(`${C.yellow}⚠${C.reset} A previous run was still active — both now run concurrently`);
        }
      } catch (e) {
        if (e instanceof Error && (e.name === "TimeoutError" || e.message.includes("fetch"))) {
          fail("PPM server not running — start with 'ppm start'");
        }
        fail(e instanceof Error ? e.message : String(e));
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
}
