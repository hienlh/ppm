import { configService } from "../config.service.ts";
import { chatService } from "../chat.service.ts";
import {
  isPairedChat,
  getPairingByChatId,
  createPairingRequest,
  approvePairing,
} from "../db.service.ts";
import { PPMBotTelegram } from "./ppmbot-telegram.ts";
import { PPMBotSessionManager } from "./ppmbot-session.ts";
import { PPMBotMemory } from "./ppmbot-memory.ts";
import { streamToTelegram } from "./ppmbot-streamer.ts";
import { escapeHtml } from "./ppmbot-formatter.ts";
import type { TelegramUpdate, PPMBotCommand } from "../../types/ppmbot.ts";
import type { PPMBotConfig, TelegramConfig, PermissionMode } from "../../types/config.ts";
import type { SendMessageOpts } from "../../types/chat.ts";

const CONTEXT_WINDOW_THRESHOLD = 80;

class PPMBotService {
  private telegram: PPMBotTelegram | null = null;
  private sessions = new PPMBotSessionManager();
  private memory = new PPMBotMemory();
  private running = false;

  /** Debounce timers per chatId */
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private debouncedTexts = new Map<string, string>();

  /** Processing lock per chatId */
  private processing = new Set<string>();

  /** Message queue per chatId for concurrent messages */
  private messageQueue = new Map<string, string[]>();

  /** Sessions that already had their title set */
  private titledSessions = new Set<string>();

  /** Chat IDs that just received identity onboarding prompt */
  private identityPending = new Set<string>();

  /** Message count per session for periodic memory save */
  private messageCount = new Map<string, number>();

  /** Interval (messages) between automatic memory saves */
  private readonly MEMORY_SAVE_INTERVAL = 5;

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
      this.telegram = new PPMBotTelegram(telegramConfig.bot_token);
      this.running = true;

      // Run memory decay on startup
      this.memory.runDecay();

      // Start polling (non-blocking)
      this.telegram.startPolling((update) => this.handleUpdate(update));

      console.log("[ppmbot] Started");
    } catch (err) {
      console.error("[ppmbot] Start failed:", (err as Error).message);
    }
  }

  stop(): void {
    this.running = false;
    this.telegram?.stop();
    this.telegram = null;

    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    this.debouncedTexts.clear();
    this.processing.clear();
    this.messageQueue.clear();
    this.identityPending.clear();
    this.messageCount.clear();

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
        // First-time user — generate pairing code
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
      if (pairing.status === "revoked") {
        return; // Silently ignore
      }
    }

    // Try parsing as command
    const command = PPMBotTelegram.parseCommand(message);
    if (command) {
      await this.handleCommand(command);
      return;
    }

    // Regular message
    const text = message.text ?? message.caption ?? "";
    if (!text.trim()) return;

    await this.handleMessage(chatId, text);
  }

  // ── Command Handlers ────────────────────────────────────────────

  private async handleCommand(cmd: PPMBotCommand): Promise<void> {
    const chatId = String(cmd.chatId);
    const tg = this.telegram!;

    try {
      switch (cmd.command) {
        case "start": await this.cmdStart(chatId); break;
        case "project": await this.cmdProject(chatId, cmd.args); break;
        case "new": await this.cmdNew(chatId); break;
        case "sessions": await this.cmdSessions(chatId); break;
        case "resume": await this.cmdResume(chatId, cmd.args); break;
        case "status": await this.cmdStatus(chatId); break;
        case "stop": await this.cmdStop(chatId); break;
        case "memory": await this.cmdMemory(chatId); break;
        case "forget": await this.cmdForget(chatId, cmd.args); break;
        case "remember": await this.cmdRemember(chatId, cmd.args); break;
        case "help": await this.cmdHelp(chatId); break;
        default: await tg.sendMessage(Number(chatId), `Unknown command: /${cmd.command}`);
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
    let text = "<b>🤖 PPMBot</b>\n\n";
    text += "Hey! I'm your AI coding assistant, right here in Telegram.\n";
    text += "Ask me anything — code questions, debugging, project tasks.\n\n";
    if (projects.length) {
      text += "<b>Your projects:</b>\n";
      for (const name of projects) {
        text += `  • <code>${escapeHtml(name)}</code>\n`;
      }
      text += "\nSwitch: /project &lt;name&gt;";
    } else {
      text += "No projects configured — I'll use a default workspace.";
    }
    text += "\n\nJust send a message to start chatting, or /help for commands.";
    await this.telegram!.sendMessage(Number(chatId), text);

    // Identity onboarding: if no identity memories exist, ask user
    const identityMemories = this.memory.recall("_global", "user identity name role");
    if (identityMemories.length === 0) {
      this.identityPending.add(chatId);
      await this.telegram!.sendMessage(
        Number(chatId),
        "📝 <b>Quick intro?</b>\n\n" +
          "I don't know much about you yet! Tell me:\n" +
          "• Your name\n" +
          "• What you work on (language, stack, role)\n" +
          "• Preferred response language (English, Vietnamese, etc.)\n\n" +
          "I'll remember your preferences for future chats.\n" +
          "Or skip this and just start chatting!",
      );
    }
  }

  private async cmdProject(chatId: string, args: string): Promise<void> {
    if (!args) {
      const active = this.sessions.getActiveSession(chatId);
      const current = active?.projectName ?? "(none)";
      await this.telegram!.sendMessage(
        Number(chatId),
        `Current project: <b>${escapeHtml(current)}</b>\n\nUsage: /project &lt;name&gt;`,
      );
      return;
    }

    await this.saveSessionMemory(chatId);
    const session = await this.sessions.switchProject(chatId, args);
    await this.telegram!.sendMessage(
      Number(chatId),
      `Switched to <b>${escapeHtml(session.projectName)}</b> ✓`,
    );
  }

  private async cmdNew(chatId: string): Promise<void> {
    await this.saveSessionMemory(chatId);
    const active = this.sessions.getActiveSession(chatId);
    const projectName = active?.projectName;
    await this.sessions.closeSession(chatId);
    const session = await this.sessions.getOrCreateSession(chatId, projectName ?? undefined);
    await this.telegram!.sendMessage(
      Number(chatId),
      `New session for <b>${escapeHtml(session.projectName)}</b> ✓`,
    );
  }

  private async cmdSessions(chatId: string): Promise<void> {
    const sessions = this.sessions.listRecentSessions(chatId, 10);
    if (sessions.length === 0) {
      await this.telegram!.sendMessage(Number(chatId), "No recent sessions.");
      return;
    }
    let text = "<b>Recent Sessions</b>\n\n";
    sessions.forEach((s, i) => {
      const active = s.is_active ? " ⬤" : "";
      const date = new Date(s.last_message_at * 1000).toLocaleDateString();
      text += `${i + 1}. <code>${escapeHtml(s.project_name)}</code> — ${date}${active}\n`;
    });
    text += "\nResume: /resume &lt;number&gt;";
    await this.telegram!.sendMessage(Number(chatId), text);
  }

  private async cmdResume(chatId: string, args: string): Promise<void> {
    const index = parseInt(args, 10);
    if (!index || index < 1) {
      await this.telegram!.sendMessage(Number(chatId), "Usage: /resume &lt;number&gt;");
      return;
    }
    await this.saveSessionMemory(chatId);
    const session = await this.sessions.resumeSessionById(chatId, index);
    if (!session) {
      await this.telegram!.sendMessage(Number(chatId), "Session not found.");
      return;
    }
    await this.telegram!.sendMessage(
      Number(chatId),
      `Resumed session for <b>${escapeHtml(session.projectName)}</b> ✓`,
    );
  }

  private async cmdStatus(chatId: string): Promise<void> {
    const active = this.sessions.getActiveSession(chatId);
    if (!active) {
      await this.telegram!.sendMessage(Number(chatId), "No active session. Send a message to start.");
      return;
    }
    let text = "<b>Status</b>\n\n";
    text += `Project: <code>${escapeHtml(active.projectName)}</code>\n`;
    text += `Provider: <code>${escapeHtml(active.providerId)}</code>\n`;
    text += `Session: <code>${active.sessionId.slice(0, 12)}…</code>\n`;
    await this.telegram!.sendMessage(Number(chatId), text);
  }

  private async cmdStop(chatId: string): Promise<void> {
    await this.saveSessionMemory(chatId);
    await this.sessions.closeSession(chatId);
    await this.telegram!.sendMessage(Number(chatId), "Session ended ✓");
  }

  private async cmdMemory(chatId: string): Promise<void> {
    const active = this.sessions.getActiveSession(chatId);
    const project = active?.projectName ?? "_global";
    const memories = this.memory.getSummary(project);
    if (memories.length === 0) {
      await this.telegram!.sendMessage(Number(chatId), "No memories stored for this project.");
      return;
    }
    let text = `<b>Memory — ${escapeHtml(project)}</b>\n\n`;
    for (const mem of memories) {
      text += `• [${mem.category}] ${escapeHtml(mem.content)}\n`;
    }
    await this.telegram!.sendMessage(Number(chatId), text);
  }

  private async cmdForget(chatId: string, args: string): Promise<void> {
    if (!args) {
      await this.telegram!.sendMessage(Number(chatId), "Usage: /forget &lt;topic&gt;");
      return;
    }
    const active = this.sessions.getActiveSession(chatId);
    const project = active?.projectName ?? "_global";
    const count = this.memory.forget(project, args);
    await this.telegram!.sendMessage(Number(chatId), `Forgot ${count} memor${count === 1 ? "y" : "ies"} ✓`);
  }

  private async cmdRemember(chatId: string, args: string): Promise<void> {
    if (!args) {
      await this.telegram!.sendMessage(Number(chatId), "Usage: /remember &lt;fact&gt;");
      return;
    }
    const active = this.sessions.getActiveSession(chatId);
    const project = active?.projectName ?? "_global";
    this.memory.saveOne(project, args, "fact", active?.sessionId);
    await this.telegram!.sendMessage(Number(chatId), "Remembered ✓");
  }

  private async cmdHelp(chatId: string): Promise<void> {
    const text = `<b>PPMBot Commands</b>

/start — Greeting + list projects
/project &lt;name&gt; — Switch project
/new — Fresh session (current project)
/sessions — List recent sessions
/resume &lt;n&gt; — Resume session #n
/status — Current project/session info
/stop — End current session
/memory — Show project memories
/forget &lt;topic&gt; — Remove matching memories
/remember &lt;fact&gt; — Save a fact
/help — This message`;
    await this.telegram!.sendMessage(Number(chatId), text);
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

    // Queue if already processing
    if (this.processing.has(chatId)) {
      const queue = this.messageQueue.get(chatId) ?? [];
      queue.push(text);
      this.messageQueue.set(chatId, queue);
      return;
    }
    this.processing.add(chatId);

    try {
      const config = this.getConfig();

      const session = await this.sessions.getOrCreateSession(chatId);

      // Update title on first message only
      if (!this.titledSessions.has(session.sessionId)) {
        this.sessions.updateSessionTitle(session.sessionId, text);
        this.titledSessions.add(session.sessionId);
      }

      // Recall memories (with cross-project detection)
      const memories = this.memory.recallWithCrossProject(
        session.projectName,
        text,
        text,
      );

      // Build system prompt with memory
      let systemPrompt = config?.system_prompt ?? "";
      const memorySection = this.memory.buildRecallPrompt(memories);
      if (memorySection) {
        systemPrompt += memorySection;
      }

      // Send message to AI (prepend system prompt + memory context)
      const opts: SendMessageOpts = {
        permissionMode: (config?.permission_mode ?? "bypassPermissions") as PermissionMode,
      };

      let fullMessage = text;
      if (systemPrompt) {
        fullMessage = `<system-context>\n${systemPrompt}\n</system-context>\n\n${text}`;
      }

      const events = chatService.sendMessage(
        session.providerId,
        session.sessionId,
        fullMessage,
        opts,
      );

      // Stream response to Telegram
      const result = await streamToTelegram(
        Number(chatId),
        events,
        this.telegram!,
        {
          showToolCalls: config?.show_tool_calls ?? true,
          showThinking: config?.show_thinking ?? false,
        },
      );

      // Capture identity if onboarding was just shown
      if (this.identityPending.has(chatId)) {
        this.identityPending.delete(chatId);
        this.memory.saveOne("_global", `User identity: ${text}`, "preference", session.sessionId);
        console.log("[ppmbot] Saved identity memory from onboarding");
      }

      // Periodic memory extraction — fire-and-forget every N messages
      const count = (this.messageCount.get(session.sessionId) ?? 0) + 1;
      this.messageCount.set(session.sessionId, count);
      if (count % this.MEMORY_SAVE_INTERVAL === 0) {
        this.saveSessionMemory(chatId).catch((err) =>
          console.warn("[ppmbot] Periodic memory save failed:", (err as Error).message),
        );
      }

      // Check context window — auto-rotate if near limit
      if (
        result.contextWindowPct != null &&
        result.contextWindowPct > CONTEXT_WINDOW_THRESHOLD
      ) {
        await this.rotateSession(chatId, session.projectName);
      }
    } catch (err) {
      console.error(`[ppmbot] processMessage error for ${chatId}:`, (err as Error).message);
      await this.telegram?.sendMessage(
        Number(chatId),
        `❌ ${escapeHtml((err as Error).message)}`,
      );
    } finally {
      this.processing.delete(chatId);

      // Process queued messages
      const queued = this.messageQueue.get(chatId);
      if (queued && queued.length > 0) {
        this.messageQueue.delete(chatId);
        const merged = queued.join("\n\n");
        this.handleMessage(chatId, merged);
      }
    }
  }

  // ── Memory Save / Session Rotate ────────────────────────────────

  private async saveSessionMemory(chatId: string): Promise<void> {
    const session = this.sessions.getActiveSession(chatId);
    if (!session) return;

    try {
      const extractionPrompt = this.memory.buildExtractionPrompt();
      const events = chatService.sendMessage(
        session.providerId,
        session.sessionId,
        extractionPrompt,
        { permissionMode: "bypassPermissions" },
      );

      let responseText = "";
      for await (const event of events) {
        if (event.type === "text") responseText += event.content;
      }

      const facts = this.memory.parseExtractionResponse(responseText);
      if (facts.length > 0) {
        const count = this.memory.save(session.projectName, facts, session.sessionId);
        console.log(`[ppmbot] Saved ${count} memories for ${session.projectName}`);
      } else {
        // Fallback: regex-based extraction
        // Note: we don't have conversation history text here easily,
        // so regex fallback only triggers when AI extraction fails
        console.log("[ppmbot] No memories extracted via AI");
      }
    } catch (err) {
      console.warn("[ppmbot] Memory save failed:", (err as Error).message);
    }
  }

  private async rotateSession(chatId: string, projectName: string): Promise<void> {
    await this.saveSessionMemory(chatId);
    await this.sessions.closeSession(chatId);
    await this.sessions.getOrCreateSession(chatId, projectName);
    await this.telegram?.sendMessage(
      Number(chatId),
      "<i>Context window near limit — starting fresh session. Memories saved.</i>",
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private generatePairingCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I,O,0,1 (ambiguous)
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    return Array.from(bytes, (b) => chars[b % chars.length]).join("");
  }

  private getConfig(): PPMBotConfig | undefined {
    return configService.get("clawbot") as PPMBotConfig | undefined;
  }
}

export const ppmbotService = new PPMBotService();
