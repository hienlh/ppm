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

/**
 * Resolve the Telegram chatId for CLI operations.
 * Auto-detects if exactly 1 approved paired chat exists.
 * Otherwise requires --chat flag.
 */
export async function resolveChatId(chatOpt?: string): Promise<string> {
  if (chatOpt) return chatOpt;

  const { getApprovedPairedChats } = await import("../../services/db.service.ts");
  const approved = getApprovedPairedChats();

  if (approved.length === 0) {
    throw new Error("No paired Telegram chats. Pair a device in PPM Settings first.");
  }
  if (approved.length > 1) {
    const ids = approved.map((c) => `  ${c.telegram_chat_id} (${c.display_name || "unknown"})`).join("\n");
    throw new Error(`Multiple paired chats found. Use --chat <id> to specify:\n${ids}`);
  }
  return approved[0]!.telegram_chat_id;
}

/**
 * `ppm bot` CLI — coordinator-era commands: delegation, memory, project list, status.
 */
export function registerBotCommands(program: Command): void {
  const bot = program.command("bot").description("PPMBot utilities");

  registerDelegationCommands(bot);
  registerMemoryCommands(bot);
  registerProjectCommands(bot);
  registerMiscCommands(bot);
}

// ── Delegation ─────────────────────────────────────────────────────

function registerDelegationCommands(bot: Command): void {
  bot
    .command("delegate")
    .description("Delegate a task to a project subagent")
    .requiredOption("--chat <id>", "Telegram chat ID")
    .requiredOption("--project <name>", "Project name")
    .requiredOption("--prompt <text>", "Enriched task prompt")
    .option("--timeout <ms>", "Timeout in milliseconds", "900000")
    .action(async (opts: { chat: string; project: string; prompt: string; timeout: string }) => {
      try {
        const { configService } = await import("../../services/config.service.ts");
        configService.load();
        const { PPMBotSessionManager } = await import("../../services/ppmbot/ppmbot-session.ts");
        const sessions = new PPMBotSessionManager();
        const project = sessions.resolveProject(opts.project);
        if (!project) {
          console.error(`${C.red}✗${C.reset} Project not found: ${opts.project}`);
          process.exit(1);
        }

        const taskId = crypto.randomUUID();
        const { createBotTask } = await import("../../services/db.service.ts");
        createBotTask(taskId, opts.chat, project.name, project.path, opts.prompt, Number(opts.timeout) || 900000);

        console.log(JSON.stringify({ taskId, project: project.name, status: "pending" }));
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  bot
    .command("task-status <id>")
    .description("Get status of a delegated task")
    .action(async (id: string) => {
      try {
        const { getBotTask } = await import("../../services/db.service.ts");
        const task = getBotTask(id);
        if (!task) {
          console.error(`${C.red}✗${C.reset} Task not found: ${id}`);
          process.exit(1);
        }
        const elapsed = task.startedAt
          ? Math.round((Date.now() / 1000 - task.startedAt) / 60)
          : 0;
        console.log(JSON.stringify({
          id: task.id,
          status: task.status,
          project: task.projectName,
          prompt: task.prompt.slice(0, 100),
          elapsed: `${elapsed}m`,
          summary: task.resultSummary?.slice(0, 200) ?? null,
        }));
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  bot
    .command("task-result <id>")
    .description("Get full result of a completed task")
    .action(async (id: string) => {
      try {
        const { getBotTask } = await import("../../services/db.service.ts");
        const task = getBotTask(id);
        if (!task) {
          console.error(`${C.red}✗${C.reset} Task not found: ${id}`);
          process.exit(1);
        }
        if (task.status === "completed") {
          console.log(task.resultFull ?? "(no output)");
        } else if (task.status === "failed") {
          console.error(`Task failed: ${task.error ?? "unknown error"}`);
        } else {
          console.log(`Task status: ${task.status} (not completed yet)`);
        }
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  bot
    .command("tasks")
    .description("List recent delegated tasks")
    .option("--chat <id>", "Telegram chat ID (auto-detected if single)")
    .action(async (opts: { chat?: string }) => {
      try {
        const chatId = await resolveChatId(opts.chat);
        const { getRecentBotTasks } = await import("../../services/db.service.ts");
        const tasks = getRecentBotTasks(chatId, 20);

        if (tasks.length === 0) {
          console.log(`${C.dim}No delegated tasks found.${C.reset}`);
          return;
        }

        const statusIcon: Record<string, string> = {
          pending: "⏳", running: "🔄", completed: "✅", failed: "❌", timeout: "⏱",
        };

        for (const t of tasks) {
          const icon = statusIcon[t.status] ?? "?";
          const sid = t.id.slice(0, 8);
          const prompt = t.prompt.slice(0, 50);
          console.log(`  ${icon} ${C.dim}${sid}${C.reset} ${C.bold}${t.projectName}${C.reset} — ${prompt}`);
        }
        console.log(`\n${C.dim}${tasks.length} tasks${C.reset}`);
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
}

// ── Memory ──────────────────────────────────────────────────────────

function registerMemoryCommands(bot: Command): void {
  const mem = bot.command("memory").description("Manage cross-project memories");

  mem
    .command("save <content>")
    .description("Save a cross-project memory")
    .option("-c, --category <cat>", "Category: fact|preference|decision|architecture|issue", "fact")
    .option("-s, --session <id>", "Session ID (optional)")
    .action(async (content: string, opts: { category: string; session?: string }) => {
      try {
        const { PPMBotMemory } = await import("../../services/ppmbot/ppmbot-memory.ts");
        const memory = new PPMBotMemory();
        const validCategories = ["fact", "decision", "preference", "architecture", "issue"];
        const category = validCategories.includes(opts.category) ? opts.category : "fact";
        const id = memory.saveOne("_global", content, category as any, opts.session);
        console.log(`${C.green}✓${C.reset} Saved memory #${id} [${category}]: ${content}`);
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  mem
    .command("list")
    .description("List active cross-project memories")
    .option("-l, --limit <n>", "Max results", "30")
    .option("--json", "Output as JSON")
    .action(async (opts: { limit: string; json?: boolean }) => {
      try {
        const { PPMBotMemory } = await import("../../services/ppmbot/ppmbot-memory.ts");
        const memory = new PPMBotMemory();
        const results = memory.getSummary("_global", Number(opts.limit) || 30);

        if (opts.json) {
          console.log(JSON.stringify(results, null, 2));
          return;
        }

        if (results.length === 0) {
          console.log(`${C.dim}No memories found.${C.reset}`);
          return;
        }

        for (const r of results) {
          const catTag = `${C.cyan}[${r.category}]${C.reset}`;
          console.log(`  #${r.id} ${catTag} ${r.content}`);
        }
        console.log(`\n${C.dim}${results.length} memories${C.reset}`);
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  mem
    .command("forget <topic>")
    .description("Delete memories matching a topic (FTS5 search)")
    .action(async (topic: string) => {
      try {
        const { PPMBotMemory } = await import("../../services/ppmbot/ppmbot-memory.ts");
        const memory = new PPMBotMemory();
        const deleted = memory.forget("_global", topic);
        if (deleted > 0) {
          console.log(`${C.green}✓${C.reset} Deleted ${deleted} memory(s) matching "${topic}"`);
        } else {
          console.log(`${C.yellow}No memories matched "${topic}"${C.reset}`);
        }
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
}

// ── Project ─────────────────────────────────────────────────────────

function registerProjectCommands(bot: Command): void {
  const proj = bot.command("project").description("Manage bot project context");

  proj
    .command("list")
    .description("List available projects")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const { configService } = await import("../../services/config.service.ts");
        configService.load();
        const { PPMBotSessionManager } = await import("../../services/ppmbot/ppmbot-session.ts");
        const sessions = new PPMBotSessionManager();
        const projects = sessions.getProjectNames();

        if (opts.json) {
          console.log(JSON.stringify(projects));
          return;
        }

        if (projects.length === 0) {
          console.log(`${C.dim}No projects configured.${C.reset}`);
          return;
        }

        for (const name of projects) {
          console.log(`  ${name}`);
        }
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
}

// ── Misc: status, version, restart, help ────────────────────────────

function registerMiscCommands(bot: Command): void {
  bot
    .command("status")
    .description("Show current status and running tasks")
    .option("--chat <id>", "Telegram chat ID (auto-detected if single)")
    .option("--json", "Output as JSON")
    .action(async (opts: { chat?: string; json?: boolean }) => {
      try {
        const chatId = await resolveChatId(opts.chat);
        const { getRecentBotTasks } = await import("../../services/db.service.ts");
        const tasks = getRecentBotTasks(chatId, 10);
        const active = tasks.filter((t) => t.status === "running" || t.status === "pending");

        if (opts.json) {
          console.log(JSON.stringify({ chatId, activeTasks: active.length, recentTasks: tasks.length }));
          return;
        }

        console.log(`Chat: ${chatId}`);
        console.log(`Active tasks: ${active.length}`);
        console.log(`Recent tasks: ${tasks.length}`);

        if (active.length) {
          console.log(`\n${C.cyan}Running:${C.reset}`);
          for (const t of active) {
            const elapsed = Math.round((Date.now() / 1000 - t.createdAt) / 60);
            console.log(`  🔄 ${C.dim}${t.id.slice(0, 8)}${C.reset} ${C.bold}${t.projectName}${C.reset} — ${t.prompt.slice(0, 50)} (${elapsed}m)`);
          }
        }
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  bot
    .command("version")
    .description("Show PPM version")
    .action(async () => {
      try {
        const { VERSION } = await import("../../version.ts");
        console.log(`PPM v${VERSION}`);
      } catch {
        console.log("PPM version unknown");
      }
    });

  bot
    .command("restart")
    .description("Restart the PPM server")
    .action(async () => {
      try {
        const { join } = await import("node:path");
        const { writeFileSync } = await import("node:fs");
        const { homedir } = await import("node:os");
        const { getApprovedPairedChats } = await import("../../services/db.service.ts");

        const approvedChats = getApprovedPairedChats();
        const chatIds = approvedChats.map((c) => c.telegram_chat_id);

        const markerPath = join(homedir(), ".ppm", "restart-notify.json");
        writeFileSync(markerPath, JSON.stringify({ chatIds, ts: Date.now() }));

        console.log(`${C.green}✓${C.reset} Restart signal sent (exit code 42)`);
        process.exit(42);
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  bot
    .command("help")
    .description("Show all bot CLI commands")
    .action(() => {
      console.log(`${C.bold}PPMBot CLI Commands${C.reset}

${C.cyan}Delegation:${C.reset}
  ppm bot delegate --chat <id> --project <name> --prompt "<task>"
  ppm bot task-status <id>         Check task status
  ppm bot task-result <id>         Get task result
  ppm bot tasks                    List recent tasks

${C.cyan}Memory (cross-project):${C.reset}
  ppm bot memory save "<text>"     Save a memory (-c category)
  ppm bot memory list              List saved memories
  ppm bot memory forget "<topic>"  Delete matching memories

${C.cyan}Project:${C.reset}
  ppm bot project list             List available projects

${C.cyan}Server:${C.reset}
  ppm bot status                   Current status + running tasks
  ppm bot version                  Show PPM version
  ppm bot restart                  Restart PPM server

${C.dim}Use --chat <id> if multiple chats are paired.${C.reset}`);
    });
}
