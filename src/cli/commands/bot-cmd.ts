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
 * `ppm bot` CLI — allows AI (via Bash tool) to manage PPMBot sessions,
 * projects, memories, and server operations through natural language.
 *
 * All session/project commands auto-detect the paired Telegram chat.
 */
export function registerBotCommands(program: Command): void {
  const bot = program.command("bot").description("PPMBot utilities");

  registerMemoryCommands(bot);
  registerProjectCommands(bot);
  registerSessionCommands(bot);
  registerMiscCommands(bot);
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

        // Show current project if possible
        let current = "";
        try {
          const chatId = await resolveChatId();
          const active = sessions.getActiveSession(chatId);
          current = active?.projectName ?? "";
        } catch { /* no chat — skip marker */ }

        for (const name of projects) {
          const marker = name === current ? ` ${C.green}✓${C.reset}` : "";
          console.log(`  ${name}${marker}`);
        }
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  proj
    .command("switch <name>")
    .description("Switch to a different project")
    .option("--chat <id>", "Telegram chat ID (auto-detected if single)")
    .action(async (name: string, opts: { chat?: string }) => {
      try {
        const chatId = await resolveChatId(opts.chat);
        const { PPMBotSessionManager } = await import("../../services/ppmbot/ppmbot-session.ts");
        const sessions = new PPMBotSessionManager();
        const session = await sessions.switchProject(chatId, name);
        console.log(`${C.green}✓${C.reset} Switched to ${C.bold}${session.projectName}${C.reset}`);
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  proj
    .command("current")
    .description("Show current project")
    .option("--chat <id>", "Telegram chat ID (auto-detected if single)")
    .action(async (opts: { chat?: string }) => {
      try {
        const chatId = await resolveChatId(opts.chat);
        const { PPMBotSessionManager } = await import("../../services/ppmbot/ppmbot-session.ts");
        const sessions = new PPMBotSessionManager();
        const active = sessions.getActiveSession(chatId);

        // Fallback: check DB for active session
        if (!active) {
          const { getActivePPMBotSession } = await import("../../services/db.service.ts");
          const { configService } = await import("../../services/config.service.ts");
          const projects = (configService.get("projects") as any[]) ?? [];
          for (const p of projects) {
            const dbSession = getActivePPMBotSession(chatId, p.name);
            if (dbSession) {
              console.log(dbSession.project_name);
              return;
            }
          }
          console.log(`${C.dim}No active project. Use: ppm bot project switch <name>${C.reset}`);
          return;
        }
        console.log(active.projectName);
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
}

// ── Session ─────────────────────────────────────────────────────────

function registerSessionCommands(bot: Command): void {
  const sess = bot.command("session").description("Manage chat sessions");

  sess
    .command("new")
    .description("Start a fresh session (current project)")
    .option("--chat <id>", "Telegram chat ID (auto-detected if single)")
    .action(async (opts: { chat?: string }) => {
      try {
        const chatId = await resolveChatId(opts.chat);
        const { PPMBotSessionManager } = await import("../../services/ppmbot/ppmbot-session.ts");
        const sessions = new PPMBotSessionManager();

        // Get current project before closing
        const active = sessions.getActiveSession(chatId);
        const projectName = active?.projectName;
        await sessions.closeSession(chatId);
        const session = await sessions.getOrCreateSession(chatId, projectName ?? undefined);
        console.log(`${C.green}✓${C.reset} New session for ${C.bold}${session.projectName}${C.reset} (${session.sessionId.slice(0, 8)})`);
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  sess
    .command("list")
    .description("List recent sessions")
    .option("--chat <id>", "Telegram chat ID (auto-detected if single)")
    .option("-l, --limit <n>", "Max results", "20")
    .option("--json", "Output as JSON")
    .action(async (opts: { chat?: string; limit: string; json?: boolean }) => {
      try {
        const chatId = await resolveChatId(opts.chat);
        const { getRecentPPMBotSessions, getSessionTitles, getPinnedSessionIds } = await import("../../services/db.service.ts");
        const allSessions = getRecentPPMBotSessions(chatId, Number(opts.limit) || 20);

        if (allSessions.length === 0) {
          console.log(`${C.dim}No sessions found.${C.reset}`);
          return;
        }

        const titles = getSessionTitles(allSessions.map((s) => s.session_id));
        const pinnedIds = getPinnedSessionIds();

        // Sort: pinned first, then by last_message_at desc
        const sorted = [...allSessions].sort((a, b) => {
          const aPin = pinnedIds.has(a.session_id) ? 1 : 0;
          const bPin = pinnedIds.has(b.session_id) ? 1 : 0;
          if (aPin !== bPin) return bPin - aPin;
          return b.last_message_at - a.last_message_at;
        });

        if (opts.json) {
          const jsonData = sorted.map((s, i) => ({
            index: i + 1,
            sessionId: s.session_id,
            project: s.project_name,
            title: titles[s.session_id]?.replace(/^\[PPM\]\s*/, "") || "",
            pinned: pinnedIds.has(s.session_id),
            active: !!s.is_active,
            lastMessage: new Date(s.last_message_at * 1000).toISOString(),
          }));
          console.log(JSON.stringify(jsonData, null, 2));
          return;
        }

        for (const [i, s] of sorted.entries()) {
          const pin = pinnedIds.has(s.session_id) ? "📌 " : "   ";
          const activeDot = s.is_active ? ` ${C.green}⬤${C.reset}` : "";
          const rawTitle = titles[s.session_id]?.replace(/^\[PPM\]\s*/, "") || "";
          const title = rawTitle ? rawTitle.slice(0, 50) : `${C.dim}untitled${C.reset}`;
          const sid = s.session_id.slice(0, 8);
          const date = new Date(s.last_message_at * 1000).toLocaleString(undefined, {
            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
          });

          console.log(`${pin}${i + 1}. ${title}${activeDot}`);
          console.log(`      ${C.dim}${sid} · ${s.project_name} · ${date}${C.reset}`);
        }
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  sess
    .command("resume <target>")
    .description("Resume a session by index number or session ID prefix")
    .option("--chat <id>", "Telegram chat ID (auto-detected if single)")
    .action(async (target: string, opts: { chat?: string }) => {
      try {
        const chatId = await resolveChatId(opts.chat);
        const { PPMBotSessionManager } = await import("../../services/ppmbot/ppmbot-session.ts");
        const sessions = new PPMBotSessionManager();

        const index = parseInt(target, 10);
        const isIndex = !isNaN(index) && index >= 1 && String(index) === target.trim();

        const session = isIndex
          ? await sessions.resumeSessionById(chatId, index)
          : await sessions.resumeSessionByIdPrefix(chatId, target.trim());

        if (!session) {
          console.log(`${C.yellow}Session not found: ${target}${C.reset}`);
          process.exit(1);
        }
        console.log(`${C.green}✓${C.reset} Resumed session ${C.dim}${session.sessionId.slice(0, 8)}${C.reset} (${C.bold}${session.projectName}${C.reset})`);
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  sess
    .command("stop")
    .description("End the current session")
    .option("--chat <id>", "Telegram chat ID (auto-detected if single)")
    .action(async (opts: { chat?: string }) => {
      try {
        const chatId = await resolveChatId(opts.chat);
        const { PPMBotSessionManager } = await import("../../services/ppmbot/ppmbot-session.ts");
        const sessions = new PPMBotSessionManager();
        await sessions.closeSession(chatId);
        console.log(`${C.green}✓${C.reset} Session ended`);
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
    .description("Show current project and session info")
    .option("--chat <id>", "Telegram chat ID (auto-detected if single)")
    .option("--json", "Output as JSON")
    .action(async (opts: { chat?: string; json?: boolean }) => {
      try {
        const chatId = await resolveChatId(opts.chat);
        const { PPMBotSessionManager } = await import("../../services/ppmbot/ppmbot-session.ts");
        const sessions = new PPMBotSessionManager();
        const active = sessions.getActiveSession(chatId);

        // Fallback: check DB for any active session
        let project = active?.projectName ?? "";
        let provider = active?.providerId ?? "";
        let sessionId = active?.sessionId ?? "";

        if (!active) {
          const { getRecentPPMBotSessions } = await import("../../services/db.service.ts");
          const recent = getRecentPPMBotSessions(chatId, 1);
          if (recent.length > 0 && recent[0]!.is_active) {
            project = recent[0]!.project_name;
            provider = recent[0]!.provider_id;
            sessionId = recent[0]!.session_id;
          }
        }

        if (opts.json) {
          console.log(JSON.stringify({ chatId, project, provider, sessionId }));
          return;
        }

        if (!project) {
          console.log(`${C.dim}No active session. Use: ppm bot project switch <name>${C.reset}`);
          return;
        }

        console.log(`Project:  ${C.bold}${project}${C.reset}`);
        console.log(`Provider: ${provider}`);
        console.log(`Session:  ${C.dim}${sessionId.slice(0, 12)}…${C.reset}`);
        console.log(`Chat:     ${chatId}`);
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

${C.cyan}Project:${C.reset}
  ppm bot project list             List available projects
  ppm bot project switch <name>    Switch to a project
  ppm bot project current          Show current project

${C.cyan}Session:${C.reset}
  ppm bot session new              Start fresh session
  ppm bot session list             List recent sessions
  ppm bot session resume <n|id>    Resume a session
  ppm bot session stop             End current session

${C.cyan}Memory (cross-project):${C.reset}
  ppm bot memory save "<text>"     Save a memory (-c category)
  ppm bot memory list              List saved memories
  ppm bot memory forget "<topic>"  Delete matching memories

${C.cyan}Server:${C.reset}
  ppm bot status                   Current project/session info
  ppm bot version                  Show PPM version
  ppm bot restart                  Restart PPM server

${C.dim}Session/project commands auto-detect your Telegram chat.
Use --chat <id> if multiple chats are paired.${C.reset}`);
    });
}
