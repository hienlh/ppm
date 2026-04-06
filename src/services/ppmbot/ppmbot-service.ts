import { configService } from "../config.service.ts";
import { chatService } from "../chat.service.ts";
import {
  isPairedChat,
  getPairingByChatId,
  createPairingRequest,
  getSessionTitles,
  getPinnedSessionIds,
  getApprovedPairedChats,
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

      // Start polling (non-blocking)
      this.telegram.startPolling((update) => this.handleUpdate(update));

      // Check if this is a restart and notify users
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

    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    this.debouncedTexts.clear();
    this.processing.clear();
    this.messageQueue.clear();
    this.identityPending.clear();

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
        case "sessions": await this.cmdSessions(chatId, cmd.args); break;
        case "resume": await this.cmdResume(chatId, cmd.args); break;
        case "status": await this.cmdStatus(chatId); break;
        case "stop": await this.cmdStop(chatId); break;
        case "memory": await this.cmdMemory(chatId); break;
        case "forget": await this.cmdForget(chatId, cmd.args); break;
        case "remember": await this.cmdRemember(chatId, cmd.args); break;
        case "restart": await this.cmdRestart(chatId); break;
        case "version": await this.cmdVersion(chatId); break;
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
    const globalMemories = this.memory.getSummary("_global", 50);
    const hasIdentity = globalMemories.some((m) =>
      m.category === "preference" && /identity|name|role/i.test(m.content),
    );
    if (!hasIdentity) {
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
      const current = active?.projectName ?? "";
      const projects = this.sessions.getProjectNames();
      let text = "<b>Projects</b>\n\n";
      if (projects.length === 0) {
        text += "No projects configured.\nUsing default: <code>~/.ppm/bot/</code>\n";
      } else {
        for (const name of projects) {
          const marker = name === current ? " ✓" : "";
          text += `• <code>${escapeHtml(name)}</code>${marker}\n`;
        }
      }
      text += `\nCurrent: <b>${escapeHtml(current || "bot (default)")}</b>`;
      text += "\nSwitch: /project &lt;name&gt;";
      await this.telegram!.sendMessage(Number(chatId), text);
      return;
    }

    const session = await this.sessions.switchProject(chatId, args);
    await this.telegram!.sendMessage(
      Number(chatId),
      `Switched to <b>${escapeHtml(session.projectName)}</b> ✓`,
    );
  }

  private async cmdNew(chatId: string): Promise<void> {
    const active = this.sessions.getActiveSession(chatId);
    const projectName = active?.projectName;
    await this.sessions.closeSession(chatId);
    const session = await this.sessions.getOrCreateSession(chatId, projectName ?? undefined);
    await this.telegram!.sendMessage(
      Number(chatId),
      `New session for <b>${escapeHtml(session.projectName)}</b> ✓`,
    );
  }

  private async cmdSessions(chatId: string, args: string): Promise<void> {
    const PAGE_SIZE = 8;
    const page = Math.max(1, parseInt(args, 10) || 1);

    const active = this.sessions.getActiveSession(chatId);
    const project = active?.projectName;

    // Fetch all sessions for this chat (enough for pagination)
    const allSessions = this.sessions.listRecentSessions(chatId, 50);
    // Filter by current project if one is active
    const filtered = project
      ? allSessions.filter((s) => s.project_name === project)
      : allSessions;

    if (filtered.length === 0) {
      await this.telegram!.sendMessage(Number(chatId), "No sessions yet. Send a message to start.");
      return;
    }

    // Enrich with titles and pin status
    const titles = getSessionTitles(filtered.map((s) => s.session_id));
    const pinnedIds = getPinnedSessionIds();

    // Sort: pinned first, then by last_message_at desc
    const sorted = [...filtered].sort((a, b) => {
      const aPin = pinnedIds.has(a.session_id) ? 1 : 0;
      const bPin = pinnedIds.has(b.session_id) ? 1 : 0;
      if (aPin !== bPin) return bPin - aPin;
      return b.last_message_at - a.last_message_at;
    });

    const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
    const start = (page - 1) * PAGE_SIZE;
    const pageItems = sorted.slice(start, start + PAGE_SIZE);

    if (pageItems.length === 0) {
      await this.telegram!.sendMessage(Number(chatId), `No sessions on page ${page}.`);
      return;
    }

    const header = project ? escapeHtml(project) : "All Projects";
    let text = `<b>Sessions — ${header}</b>`;
    if (totalPages > 1) text += ` <i>(${page}/${totalPages})</i>`;
    text += "\n\n";

    pageItems.forEach((s, i) => {
      const pin = pinnedIds.has(s.session_id) ? "📌 " : "";
      const activeDot = s.is_active ? " ⬤" : "";
      const rawTitle = titles[s.session_id]?.replace(/^\[PPM\]\s*/, "") || "";
      const title = rawTitle
        ? escapeHtml(rawTitle.slice(0, 45))
        : "<i>untitled</i>";
      const date = new Date(s.last_message_at * 1000).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      });
      const sid = s.session_id.slice(0, 8);
      const num = start + i + 1;

      text += `${pin}${num}. ${title}${activeDot}\n`;
      text += `   <code>${sid}</code> · ${date}\n\n`;
    });

    text += "Resume: /resume &lt;n&gt; or /resume &lt;id&gt;";
    if (totalPages > 1 && page < totalPages) {
      text += `\nNext: /sessions ${page + 1}`;
    }

    await this.telegram!.sendMessage(Number(chatId), text);
  }

  private async cmdResume(chatId: string, args: string): Promise<void> {
    if (!args.trim()) {
      await this.telegram!.sendMessage(Number(chatId), "Usage: /resume &lt;number or session-id&gt;");
      return;
    }

    // Support both index (e.g. "2") and session ID prefix (e.g. "fdc4ddaa")
    const index = parseInt(args, 10);
    const isIndex = !isNaN(index) && index >= 1 && String(index) === args.trim();

    const session = isIndex
      ? await this.sessions.resumeSessionById(chatId, index)
      : await this.sessions.resumeSessionByIdPrefix(chatId, args.trim());

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
    await this.sessions.closeSession(chatId);
    await this.telegram!.sendMessage(Number(chatId), "Session ended ✓");
  }

  private async cmdMemory(chatId: string): Promise<void> {
    const memories = this.memory.getSummary("_global");
    if (memories.length === 0) {
      await this.telegram!.sendMessage(Number(chatId), "No memories stored. Use /remember to add.");
      return;
    }
    let text = "<b>Memory</b> (cross-project)\n\n";
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
    const count = this.memory.forget("_global", args);
    await this.telegram!.sendMessage(Number(chatId), `Forgot ${count} memor${count === 1 ? "y" : "ies"} ✓`);
  }

  private async cmdRemember(chatId: string, args: string): Promise<void> {
    if (!args) {
      await this.telegram!.sendMessage(Number(chatId), "Usage: /remember &lt;fact&gt;");
      return;
    }
    const active = this.sessions.getActiveSession(chatId);
    this.memory.saveOne("_global", args, "fact", active?.sessionId);
    await this.telegram!.sendMessage(Number(chatId), "Remembered ✓ (cross-project)");
  }

  private async cmdRestart(chatId: string): Promise<void> {
    await this.telegram!.sendMessage(Number(chatId), "🔄 Restarting PPM...");

    // Schedule restart after a short delay so the response is sent
    setTimeout(async () => {
      const { join } = await import("node:path");
      const { writeFileSync } = await import("node:fs");
      const { homedir } = await import("node:os");

      const approvedChats = getApprovedPairedChats();
      const chatIds = approvedChats.map((c) => c.telegram_chat_id);

      // Write restart marker so we can notify after restart
      const markerPath = join(homedir(), ".ppm", "restart-notify.json");
      writeFileSync(markerPath, JSON.stringify({ chatIds, ts: Date.now() }));

      console.log("[ppmbot] Restart requested via Telegram, exiting with code 42...");
      process.exit(42);
    }, 500);
  }

  /** Check for restart notification marker and send notification */
  async checkRestartNotification(): Promise<void> {
    try {
      const { join } = await import("node:path");
      const { existsSync, readFileSync, unlinkSync } = await import("node:fs");
      const { homedir } = await import("node:os");

      const markerPath = join(homedir(), ".ppm", "restart-notify.json");
      if (!existsSync(markerPath)) return;

      const data = JSON.parse(readFileSync(markerPath, "utf-8"));
      unlinkSync(markerPath);

      // Only notify if restart was recent (< 60s)
      if (Date.now() - data.ts > 60_000) return;

      // Read version from package.json
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

  private async cmdVersion(chatId: string): Promise<void> {
    let version = "unknown";
    try {
      const { join } = await import("node:path");
      const pkgPath = join(import.meta.dir, "../../../package.json");
      const pkg = await Bun.file(pkgPath).json();
      version = pkg.version ?? "unknown";
    } catch {}
    await this.telegram!.sendMessage(Number(chatId), `<b>PPM</b> v${version}`);
  }

  private async cmdHelp(chatId: string): Promise<void> {
    const text = `<b>PPMBot Commands</b>

/start — Greeting + list projects
/project &lt;name&gt; — Switch/list projects
/new — Fresh session (current project)
/sessions [page] — List sessions (current project)
/resume &lt;n or id&gt; — Resume session
/status — Current project/session info
/stop — End current session
/memory — Show project memories
/forget &lt;topic&gt; — Remove matching memories
/remember &lt;fact&gt; — Save a fact
/restart — Restart PPM server
/version — Show PPM version
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

      // Recall identity & preferences (global + project)
      const memories = this.memory.getSummary(session.projectName);

      // Build system prompt with identity/preferences
      let systemPrompt = config?.system_prompt ?? "";
      const memorySection = this.memory.buildRecallPrompt(memories);
      if (memorySection) {
        systemPrompt += memorySection;
      }

      // Instruct AI to use CLI for cross-project memory persistence
      systemPrompt += `\n\n## Cross-Project Memory Tool
When the user asks you to remember something, change how you address them, or save any preference/fact that should persist across projects and sessions, use the Bash tool to run:
  ppm bot memory save "<content>" --category <category>
Categories: preference, fact, decision, architecture, issue
To list saved memories: ppm bot memory list
To forget: ppm bot memory forget "<topic>"
This saves to a global store that persists across all projects and sessions.`;

      // Send message to AI (prepend system prompt + memory context)
      const opts: SendMessageOpts = {
        permissionMode: (config?.permission_mode ?? "bypassPermissions") as PermissionMode,
      };

      // Save identity BEFORE streaming — must persist even if streaming times out
      let messageForAI = text;
      if (this.identityPending.has(chatId)) {
        this.identityPending.delete(chatId);
        this.memory.saveOne("_global", `User identity: ${text}`, "preference", session.sessionId);
        console.log("[ppmbot] Saved identity memory from onboarding");
        // Tell AI this is an identity intro so it acknowledges warmly
        messageForAI = `[User just introduced themselves in response to onboarding prompt. Acknowledge warmly and briefly.]\n\n${text}`;
      }

      let fullMessage = messageForAI;
      if (systemPrompt) {
        fullMessage = `<system-context>\n${systemPrompt}\n</system-context>\n\n${messageForAI}`;
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

  // ── Session Rotate ──────────────────────────────────────────────

  private async rotateSession(chatId: string, projectName: string): Promise<void> {
    await this.sessions.closeSession(chatId);
    await this.sessions.getOrCreateSession(chatId, projectName);
    await this.telegram?.sendMessage(
      Number(chatId),
      "<i>Context window near limit — starting fresh session.</i>",
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
