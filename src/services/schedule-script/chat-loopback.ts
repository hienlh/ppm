/**
 * One chat turn sent the way a browser sends it: through the chat WebSocket handler, over a
 * socket that lives in this process. The turn therefore shows live in PPM, the session is busy
 * while it runs, and accounts rotate exactly as in any chat — which a direct
 * `chatService.sendMessage` would not give (it never sets the session's phase).
 *
 * Reads the events as the bots' `runTurn` (`ppm-chat.js`) does: a session that is not idle is
 * busy and gets nothing; a subagent's events are skipped; the answer is the text after the
 * turn's last tool call; any `error` event or a result other than `success` fails the turn.
 * Unlike a real socket this one cannot close under the turn, so a turn that ends without a
 * `done` — the session deleted mid-turn, a message PPM dropped — is caught by its phase instead.
 */
import { chatWebSocket } from "../../server/ws/chat.ts";

export interface ChatTurnOutcome {
  ok: boolean;
  /** The text after the turn's last top-level tool call. */
  text: string;
  /** The session the turn ran in; a provider may move it to an id of its own. */
  sessionId: string;
  busy?: boolean;
  timedOut?: boolean;
  error?: string;
  costUsd?: number;
  numTurns?: number;
  /** The account PPM reported for the turn. */
  account?: string;
}

export interface ChatTurn {
  /**
   * Whether the turn started, known once PPM has taken the session out of idle: false when the
   * session was busy or PPM did not start the turn (`done` says why).
   */
  sent: Promise<boolean>;
  done: Promise<ChatTurnOutcome>;
}

export interface ChatTurnOptions {
  sessionId: string;
  projectName: string;
  content: string;
  permissionMode?: string;
  timeoutMs: number;
}

type ChatEvent = { type?: string; [key: string]: unknown };

export function startChatTurn(opts: ChatTurnOptions): ChatTurn {
  let settled = false;
  let sent = false;
  let phase: string | null = null;
  let left = false; // the session went past idle after the message: the turn started
  let text = "";
  let account: string | undefined;
  let lastError: string | undefined;
  let resolveSent!: (value: boolean) => void;
  let resolveDone!: (value: ChatTurnOutcome) => void;
  const sentPromise = new Promise<boolean>((r) => { resolveSent = r; });
  const done = new Promise<ChatTurnOutcome>((r) => { resolveDone = r; });

  const ws = {
    data: { type: "chat", sessionId: opts.sessionId, projectName: opts.projectName, origin: "scheduler" as const },
    send: (json: string) => {
      let ev: ChatEvent;
      try { ev = JSON.parse(json) as ChatEvent; } catch { return; }
      if (!sent) {
        if (ev.type === "session_state" && phase === null) phase = String(ev.phase);
        return;
      }
      onEvent(ev);
    },
  };

  const finish = (out: Omit<ChatTurnOutcome, "text" | "sessionId" | "account">) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { chatWebSocket.close(ws); } catch { /* entry already gone */ }
    resolveSent(left);
    resolveDone({ ...out, text: text.trim(), sessionId: ws.data.sessionId, ...(account !== undefined && { account }) });
  };

  const onEvent = (ev: ChatEvent) => {
    if (settled || ev.parentToolUseId) return;
    if (ev.type === "text" && typeof ev.content === "string") text += ev.content;
    else if (ev.type === "tool_use") text = "";
    else if (ev.type === "account_info" && typeof ev.accountLabel === "string") account = ev.accountLabel;
    else if (ev.type === "error") lastError = String(ev.message ?? "PPM reported an error");
    else if (ev.type === "message_rejected") finish({ ok: false, error: String(ev.reason ?? ev.message ?? "PPM rejected the message") });
    else if (ev.type === "done") {
      const subtype = typeof ev.resultSubtype === "string" ? ev.resultSubtype : "success";
      finish({
        ok: !lastError && subtype === "success",
        ...(lastError ? { error: lastError } : subtype !== "success" ? { error: `The turn ended with ${subtype}` } : {}),
        ...(typeof ev.costUsd === "number" && { costUsd: ev.costUsd }),
        ...(typeof ev.numTurns === "number" && { numTurns: ev.numTurns }),
      });
    } else if (ev.type === "phase_changed") {
      if (ev.phase !== "idle") {
        left = true;
        resolveSent(true);
      } else if (left) finish({ ok: false, error: lastError ?? "The turn ended without a result" });
    }
  };

  const timer = setTimeout(() => {
    if (sent) void chatWebSocket.message(ws, JSON.stringify({ type: "cancel" })).catch(() => {});
    finish({ ok: false, timedOut: true, error: `No answer after ${formatDuration(opts.timeoutMs)}` });
  }, opts.timeoutMs);

  void (async () => {
    try {
      chatWebSocket.open(ws);
      if (phase !== "idle") {
        finish({ ok: false, busy: true, error: `PPM session is ${phase ?? "not answering"}` });
        return;
      }
      // Not out yet as far as the caller knows: PPM resumes the session before it leaves idle,
      // and a second message in that window would find it idle too and start a second turn.
      sent = true;
      await chatWebSocket.message(ws, JSON.stringify({
        type: "message",
        content: opts.content,
        ...(opts.permissionMode && { permissionMode: opts.permissionMode }),
      }));
      // Every path that starts a turn moves the phase before the handler returns.
      if (!left) finish({ ok: false, error: lastError ?? "PPM did not start the turn" });
    } catch (e) {
      finish({ ok: false, error: `PPM chat failed: ${(e as Error).message}` });
    }
  })();

  return { sent: sentPromise, done };
}

function formatDuration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}
