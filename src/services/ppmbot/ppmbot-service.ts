import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { configService } from "../config.service.ts";
import { chatService } from "../chat.service.ts";
import {
  isPairedChat,
  getPairingByChatId,
  createPairingRequest,
  getApprovedPairedChats,
  getRecentBotTasks,
  getRunningBotTasks,
  updateBotTaskStatus,
  markBotTaskReported,
} from "../db.service.ts";
import { PPMBotTelegram } from "./ppmbot-telegram.ts";
import { PPMBotSessionManager, ensureCoordinatorWorkspace, DEFAULT_COORDINATOR_IDENTITY } from "./ppmbot-session.ts";
import { PPMBotMemory } from "./ppmbot-memory.ts";
import { streamToTelegram } from "./ppmbot-streamer.ts";
import { escapeHtml } from "./ppmbot-formatter.ts";
import { executeDelegation, getActiveDelegationCount } from "./ppmbot-delegation.ts";
import type { TelegramUpdate, PPMBotCommand } from "../../types/ppmbot.ts";
import type { PPMBotConfig, TelegramConfig, ProjectConfig, PermissionMode } from "../../types/config.ts";
import type { SendMessageOpts } from "../../types/chat.ts";

const CONTEXT_WINDOW_THRESHOLD = 80;

class PPMBotService {
  private telegram: PPMBotTelegram | null = null;
  private sessions = new PPMBotSessionManager();
  private memory = new PPMBotMemory();
  private running = false;

  /** Cached coordinator identity from coordinator.md */
  private coordinatorIdentity = "";

  /** Task polling interval */
  private taskPoller: ReturnType<typeof setInterval> | null = null;

  /** Debounce timers per chatId */
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private debouncedTexts = new Map<string, string>();

  /** Processing lock per chatId */
  private processing = new Set<string>();

  /** Message queue per chatId for concurrent messages */
  private messageQueue = new Map<string, string[]>();

  // ── Lifecycle ─────────────────────────────────────────────────

  async start(): Promise<void> {
    const ppmbotConfig = this.getConfig();
    if (!ppmbotConfig?.enabled) {
      console.log("[ppmbot] Disabled in config");
      return;
    }

    const telegramConfig = configService.get("telegram") as TelegramConfig | undefined;
    if (!telegramConfig?.bot_token) {
      console.log("[ppmbot] No bot token configured");
      return;
    }

    try {
      ensureCoordinatorWorkspace();

      this.telegram = new PPMBotTelegram(telegramConfig.bot_token);
      this.running = true;

      this.telegram.startPolling((update) => this.handleUpdate(update));

      // Task poller for delegation execution
      this.taskPoller = setInterval(() => this.checkPendingTasks(), 5000);
      this.cleanupStaleTasks();

      await this.checkRestartNotification();

      console.log("[ppmbot] Started");
    } catch (err) {
      console.error("[ppmbot] Start failed:", (err as Error).message);
    }
  }

  stop(): void {
    this.running = false;
    this.telegram?.stop();
    this.telegram = null;

    if (this.taskPoller) {
      clearInterval(this.taskPoller);
      this.taskPoller = null;
    }

    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    this.debouncedTexts.clear();
    this.processing.clear();
    this.messageQueue.clear();

    console.log("[ppmbot] Stopped");
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Notify user on Telegram that their pairing was approved */
  async notifyPairingApproved(chatId: string): Promise<void> {
    await this.telegram?.sendMessage(
      Number(chatId),
      "✅ Pairing approved! You can now chat with PPMBot.\n\nSend /start to begin.",
    );
  }

  // ── Update Routing ──────────────────────────────────────────────

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (!this.telegram) return;
    const message = update.message;
    if (!message?.chat?.id) return;

    const chatId = String(message.chat.id);
    const userId = message.from?.id ?? 0;
    const displayName = message.from?.first_name ?? message.from?.username ?? "Unknown";

    // Pairing-based access control
    if (!isPairedChat(chatId)) {
      const pairing = getPairingByChatId(chatId);
      if (!pairing) {
        const code = this.generatePairingCode();
        createPairingRequest(chatId, String(userId), displayName, code);
        await this.telegram!.sendMessage(
          Number(chatId),
          `🔐 Pairing required.\n\nYour pairing code: <code>${code}</code>\n\nEnter this code in PPM Settings → PPMBot → Pair Device to approve access.`,
        );
        return;
      }
      if (pairing.status === "pending") {
        await this.telegram!.sendMessage(
          Number(chatId),
          `⏳ Pairing pending approval.\n\nCode: <code>${pairing.pairing_code}</code>\nAsk the PPM owner to approve in Settings → PPMBot.`,
        );
        return;
      }
      if (pairing.status === "revoked") return;
    }

    const command = PPMBotTelegram.parseCommand(message);
    if (command) {
      await this.handleCommand(command);
      return;
    }

    const text = message.text ?? message.caption ?? "";
    if (!text.trim()) return;

    await this.handleMessage(chatId, text);
  }

  // ── Command Handlers (3 commands + hidden restart) ──────────────

  private async handleCommand(cmd: PPMBotCommand): Promise<void> {
    const chatId = String(cmd.chatId);
    const tg = this.telegram!;

    try {
      switch (cmd.command) {
        case "start": await this.cmdStart(chatId); break;
        case "status": await this.cmdStatus(chatId); break;
        case "restart": await this.cmdRestart(chatId); break;
        case "help": await this.cmdHelp(chatId); break;
        default: await tg.sendMessage(Number(chatId), `Just chat naturally — I'll handle it! Try /help`);
      }
    } catch (err) {
      await tg.sendMessage(
        Number(chatId),
        `❌ Command error: ${escapeHtml((err as Error).message)}`,
      );
    }
  }

  private async cmdStart(chatId: string): Promise<void> {
    const projects = this.sessions.getProjectNames();
    let text = "<b>🤖 PPMBot Coordinator</b>\n\n";
    text += "I'm your AI project coordinator on Telegram.\n";
    text += "Ask me anything — I'll answer directly or delegate to your projects.\n\n";
    if (projects.length) {
      text += "<b>Your projects:</b>\n";
      for (const name of projects) {
        text += `  • <code>${escapeHtml(name)}</code>\n`;
      }
    }
    text += "\nJust chat naturally — no commands needed!";
    text += "\nType /help for more info.";
    await this.telegram!.sendMessage(Number(chatId), text);

    // Identity onboarding
    const globalMemories = this.memory.getSummary("_global", 50);
    const hasIdentity = globalMemories.some((m) =>
      m.category === "preference" && /identity|name|role/i.test(m.content),
    );
    if (!hasIdentity) {
      await this.telegram!.sendMessage(
        Number(chatId),
        "📝 <b>Quick intro?</b>\n\n" +
          "Tell me your name, what you work on, and preferred language.\n" +
          "I'll remember for future chats. Or just start chatting!",
      );
    }
  }

  private async cmdStatus(chatId: string): Promise<void> {
    const tasks = getRecentBotTasks(chatId, 10);
    const active = tasks.filter((t) => t.status === "running" || t.status === "pending");
    const completed = tasks.filter((t) => t.status === "completed");
    const delegationCount = getActiveDelegationCount();

    let text = "<b>PPMBot Status</b>\n\n";
    text += `Active delegations: ${delegationCount}\n`;

    if (active.length) {
      text += "\n<b>Running Tasks:</b>\n";
      for (const t of active) {
        const elapsed = Math.round((Date.now() / 1000 - t.createdAt) / 60);
        text += `  🔄 <code>${t.id.slice(0, 8)}</code> ${escapeHtml(t.projectName)} — ${escapeHtml(t.prompt.slice(0, 50))} (${elapsed}m)\n`;
      }
    }
    if (completed.length) {
      text += "\n<b>Recent Completed:</b>\n";
      for (const t of completed.slice(0, 5)) {
        text += `  ✅ <code>${t.id.slice(0, 8)}</code> ${escapeHtml(t.projectName)} — ${escapeHtml(t.prompt.slice(0, 50))}\n`;
      }
    }
    if (!active.length && !completed.length) {
      text += "No recent tasks.";
    }
    await this.telegram!.sendMessage(Number(chatId), text);
  }

  private async cmdRestart(chatId: string): Promise<void> {
    await this.telegram!.sendMessage(Number(chatId), "🔄 Restarting PPM...");
    setTimeout(async () => {
      const { writeFileSync } = await import("node:fs");
      const approvedChats = getApprovedPairedChats();
      const chatIds = approvedChats.map((c) => c.telegram_chat_id);
      const markerPath = join(homedir(), ".ppm", "restart-notify.json");
      writeFileSync(markerPath, JSON.stringify({ chatIds, ts: Date.now() }));
      console.log("[ppmbot] Restart requested via Telegram, exiting with code 42...");
      process.exit(42);
    }, 500);
  }

  private async cmdHelp(chatId: string): Promise<void> {
    const text = `<b>PPMBot Commands</b>

/start — Welcome + list projects
/status — Running tasks + delegations
/help — This message

<b>Everything else:</b> just chat naturally!
I'll answer directly or delegate to your project's AI.`;
    await this.telegram!.sendMessage(Number(chatId), text);
  }

  // ── Coordinator Context ─────────────────────────────────────────

  private readCoordinatorIdentity(): string {
    if (this.coordinatorIdentity) return this.coordinatorIdentity;
    const identityPath = join(homedir(), ".ppm", "bot", "coordinator.md");
    try {
      this.coordinatorIdentity = readFileSync(identityPath, "utf-8");
    } catch {
      this.coordinatorIdentity = DEFAULT_COORDINATOR_IDENTITY;
    }
    return this.coordinatorIdentity;
  }

  private buildCoordinatorContext(chatId: string): string {
    const parts: string[] = [];

    // Identity
    const identity = this.readCoordinatorIdentity();
    if (identity) {
      parts.push("## Identity");
      parts.push(identity);
    }

    // Session info
    parts.push(`\n## Session Info`);
    parts.push(`Chat ID: ${chatId}`);

    // Custom system prompt (user overrides)
    const config = this.getConfig();
    if (config?.system_prompt) {
      parts.push(`\n## Custom Instructions`);
      parts.push(config.system_prompt);
    }

    // Project list
    const projects = configService.get("projects") as ProjectConfig[];
    if (projects?.length) {
      parts.push("\n## Available Projects");
      for (const p of projects) {
        parts.push(`- ${p.name} (${p.path})`);
      }
    }

    // Running/recent tasks
    const tasks = getRecentBotTasks(chatId, 10);
    const activeTasks = tasks.filter((t) => t.status === "running" || t.status === "pending");
    if (activeTasks.length) {
      parts.push("\n## Running Tasks");
      for (const t of activeTasks) {
        const elapsed = Math.round((Date.now() / 1000 - t.createdAt) / 60);
        parts.push(`- ${t.id.slice(0, 8)}: ${t.projectName} — "${t.prompt.slice(0, 60)}" (${t.status}, ${elapsed}m ago)`);
      }
    }

    // Completed tasks not yet reported
    const completed = tasks.filter((t) => t.status === "completed" && !t.reported);
    if (completed.length) {
      parts.push("\n## Completed Tasks (notify user)");
      for (const t of completed) {
        parts.push(`- ${t.id.slice(0, 8)}: ${t.projectName} — "${t.prompt.slice(0, 60)}"`);
        parts.push(`  Summary: ${t.resultSummary ?? "(use ppm bot task-result to get details)"}`);
        markBotTaskReported(t.id);
      }
    }

    // Memory recall
    const memories = this.memory.getSummary("_global");
    const memorySection = this.memory.buildRecallPrompt(memories);
    if (memorySection) parts.push(memorySection);

    return parts.join("\n");
  }

  // ── Task Delegation Polling ─────────────────────────────────────

  private checkPendingTasks(): void {
    try {
      const pending = getRunningBotTasks().filter((t) => t.status === "pending");
      for (const task of pending) {
        const config = this.getConfig();
        const providerId = config?.default_provider || configService.get("ai").default_provider;
        executeDelegation(task.id, this.telegram!, providerId);
      }
    } catch (err) {
      console.error("[ppmbot] checkPendingTasks error:", (err as Error).message);
    }
  }

  private cleanupStaleTasks(): void {
    try {
      const stale = getRunningBotTasks().filter((t) => t.status === "running");
      for (const task of stale) {
        updateBotTaskStatus(task.id, "failed", { error: "Server restarted during execution" });
        this.telegram?.sendMessage(
          Number(task.chatId),
          `⚠️ Task interrupted by server restart: <i>${escapeHtml(task.prompt.slice(0, 80))}</i>`,
        );
      }
      if (stale.length) console.log(`[ppmbot] Cleaned up ${stale.length} stale task(s)`);
    } catch (err) {
      console.error("[ppmbot] cleanupStaleTasks error:", (err as Error).message);
    }
  }

  // ── Chat Message Pipeline ───────────────────────────────────────

  private async handleMessage(chatId: string, text: string): Promise<void> {
    const config = this.getConfig();
    const debounceMs = config?.debounce_ms ?? 2000;

    const existing = this.debouncedTexts.get(chatId) ?? "";
    const merged = existing ? `${existing}\n${text}` : text;
    this.debouncedTexts.set(chatId, merged.length > 10000 ? merged.slice(0, 10000) : merged);

    const prevTimer = this.debounceTimers.get(chatId);
    if (prevTimer) clearTimeout(prevTimer);

    this.debounceTimers.set(
      chatId,
      setTimeout(() => this.processMessage(chatId), debounceMs),
    );
  }

  private async processMessage(chatId: string): Promise<void> {
    this.debounceTimers.delete(chatId);
    const text = this.debouncedTexts.get(chatId) ?? "";
    this.debouncedTexts.delete(chatId);
    if (!text.trim()) return;

    if (this.processing.has(chatId)) {
      const queue = this.messageQueue.get(chatId) ?? [];
      queue.push(text);
      this.messageQueue.set(chatId, queue);
      return;
    }
    this.processing.add(chatId);

    try {
      const config = this.getConfig();
      const session = await this.sessions.getCoordinatorSession(chatId);

      // Build coordinator context (identity + projects + tasks + memories)
      const context = this.buildCoordinatorContext(chatId);
      const fullMessage = `<coordinator-context>\n${context}\n</coordinator-context>\n\n${text}`;

      const opts: SendMessageOpts = {
        permissionMode: (config?.permission_mode ?? "bypassPermissions") as PermissionMode,
      };

      const events = chatService.sendMessage(
        session.providerId,
        session.sessionId,
        fullMessage,
        opts,
      );

      const result = await streamToTelegram(
        Number(chatId),
        events,
        this.telegram!,
        {
          showToolCalls: config?.show_tool_calls ?? true,
          showThinking: config?.show_thinking ?? false,
        },
      );

      // Context rotation
      if (
        result.contextWindowPct != null &&
        result.contextWindowPct > CONTEXT_WINDOW_THRESHOLD
      ) {
        await this.sessions.rotateCoordinatorSession(chatId);
        await this.telegram?.sendMessage(
          Number(chatId),
          "<i>Context refreshed.</i>",
        );
      }
    } catch (err) {
      console.error(`[ppmbot] processMessage error for ${chatId}:`, (err as Error).message);
      await this.telegram?.sendMessage(
        Number(chatId),
        `❌ ${escapeHtml((err as Error).message)}`,
      );
    } finally {
      this.processing.delete(chatId);

      const queued = this.messageQueue.get(chatId);
      if (queued && queued.length > 0) {
        this.messageQueue.delete(chatId);
        const merged = queued.join("\n\n");
        this.handleMessage(chatId, merged);
      }
    }
  }

  // ── Restart Notification ────────────────────────────────────────

  async checkRestartNotification(): Promise<void> {
    try {
      const { existsSync, readFileSync: fsRead, unlinkSync } = await import("node:fs");
      const markerPath = join(homedir(), ".ppm", "restart-notify.json");
      if (!existsSync(markerPath)) return;

      const data = JSON.parse(fsRead(markerPath, "utf-8"));
      unlinkSync(markerPath);

      if (Date.now() - data.ts > 60_000) return;

      let version = "";
      try {
        const pkgPath = join(import.meta.dir, "../../../package.json");
        const pkg = await Bun.file(pkgPath).json();
        version = pkg.version ? ` v${pkg.version}` : "";
      } catch {}

      for (const cid of data.chatIds) {
        await this.telegram?.sendMessage(Number(cid), `✅ PPM${version} restarted successfully.`);
      }
    } catch {}
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private generatePairingCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    return Array.from(bytes, (b) => chars[b % chars.length]).join("");
  }

  private getConfig(): PPMBotConfig | undefined {
    return configService.get("clawbot") as PPMBotConfig | undefined;
  }
}

export const ppmbotService = new PPMBotService();
