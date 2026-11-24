/**
 * Self-learning from the chat itself: after a turn that answered a voice message sent as heard,
 * the line the AI opened with — "Hiểu là: BPM → PPM" (`voice-understood.ts`), which the
 * voice-hints block asks for — is counted pair by pair toward a learned word, like the clean-up's
 * corrections are. No model call: the AI already wrote the line while answering.
 *
 * Listens on the chat lifecycle, so it works with no browser open and for Telegram too. A turn is
 * followed only when the message that opened it is the user's own voice message sent as heard:
 * origin `ws` or `telegram` (not a script through the socket), a server-written hints block, a
 * recording PPM stored, nothing forwarded in it — and the chat was idle, since a message that
 * joins a running turn would be read against that turn's answer.
 *
 * The AI's line is its own guess, so the guards are: the heard side must be in the transcript and
 * the meant side must not; the same reading must come from three different chats (within one chat
 * the AI sees and repeats its earlier reading), counted apart from the clean-up's fixes; and the
 * learned word fades after 30 unused days (source `chat`) or is undone in Settings, after which it
 * is never learned again until restored.
 */
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project.ts";
import { decodeMessageBlocks } from "../../shared/chat-message-blocks.ts";
import { redactLogText } from "../../shared/log-redact.ts";
import { splitUnderstoodLine, type UnderstoodPair } from "../../shared/voice-understood.ts";
import { isAssistantSession } from "../assistant/assistant-session.ts";
import { chatLifecycle, type ChatLifecycle } from "../chat-control/chat-lifecycle.ts";
import { createLogger } from "../logger.ts";
import { ownVoicePart } from "./voice-hints.ts";
import { CLEANUP_LEARN_LIMITS, replacementKind, type Replacement } from "./voice-learn-from-cleanup.ts";
import { wordUsedIn } from "./voice-learned-fade.ts";
import { recordCleanupReplacements } from "./voice-learned-store.ts";
import { readVoiceSettings, selfLearningOn, vocabularyOf } from "./voice-settings.ts";

const log = createLogger("voice-learning");

/** How much of the answer's first text is kept to find the line in: the line is short. */
const MAX_CAPTURE = 600;
/** A follow nobody ended (the message was refused, the turn never closed) is dropped after this. */
const FOLLOW_TTL_MS = 30 * 60 * 1000;
/** Events that end the answer's first text once it has begun; anything else (status, a task note) does not. */
const ENDS_FIRST_TEXT = new Set(["tool_use", "approval_request"]);
/** What only a running turn streams: an answer's own text, thinking or tool call (a subagent's excluded). */
const TURN_CONTENT = new Set(["text", "thinking", "tool_use"]);

interface Followed {
  chatId: string;
  project: string;
  transcript: string;
  /** The answer's first top-level text, as it streamed. */
  text: string;
  /** Still collecting: until the first line ended, a tool call came, or the cap. */
  open: boolean;
  /** The cap was reached before the first line ended: the line, if any, is cut and not read. */
  overflowed: boolean;
  startedAt: number;
}

/** Whether a text holds something PPM never stores as a learned word (a token, a key). */
const holdsSecret = (text: string) => redactLogText(text, { home: false, email: false, chats: false }) !== text;

/**
 * The pairs worth counting: the heard side said in the transcript, the meant side not (or nothing
 * was misheard), short enough to be a misheard word rather than a rewording, no secret either side.
 */
export function chatReplacements(transcript: string, pairs: readonly UnderstoodPair[], known: ReadonlySet<string>): Replacement[] {
  const out: Replacement[] = [];
  for (const { heard, meant } of pairs) {
    if (!wordUsedIn(transcript, heard) || wordUsedIn(transcript, meant)) continue;
    if (heard.split(/\s+/).length > CLEANUP_LEARN_LIMITS.maxWords || meant.split(/\s+/).length > CLEANUP_LEARN_LIMITS.maxWords) continue;
    if (meant.length > CLEANUP_LEARN_LIMITS.maxToChars || heard.length > CLEANUP_LEARN_LIMITS.maxFromChars) continue;
    if (!/\p{L}/u.test(meant) || holdsSecret(heard) || holdsSecret(meant)) continue;
    out.push({ from: heard, to: meant, kind: replacementKind(meant, known) });
  }
  return out;
}

export interface VoiceChatLearningDeps {
  lifecycle?: ChatLifecycle;
  isAssistant?: (sessionId: string) => boolean;
  now?: () => Date;
  /** Where the counting runs: after the bus returns, never inside its emit. */
  defer?: (work: () => void) => void;
}

/** Starts following voice turns; the returned function stops it. */
export function startVoiceChatLearning(deps: VoiceChatLearningDeps = {}): () => void {
  const lifecycle = deps.lifecycle ?? chatLifecycle;
  const isAssistant = deps.isAssistant ?? ((id: string) => isAssistantSession(id));
  const now = deps.now ?? (() => new Date());
  const defer = deps.defer ?? ((work: () => void) => { setTimeout(work, 0); });
  const followed = new Map<string, Followed>();
  /** Chats with a turn streaming now: a message arriving there joins it, or waits behind it. */
  const running = new Set<string>();

  const offs = [
    lifecycle.on("user_message", (m) => {
      // Joining (or queued behind) a running turn: that turn's answer is not this message's.
      if (running.has(m.sessionId)) return;
      // This message opens the chat's next turn: anything arriving before its answer streams joins it.
      running.add(m.sessionId);
      followed.delete(m.sessionId);
      if ((m.origin !== "ws" && m.origin !== "telegram") || m.traceOrigin) return;
      const decoded = decodeMessageBlocks(m.text);
      if (!decoded.voiceHints) return;
      const transcript = ownVoicePart(decoded.content)?.transcript.trim();
      if (!transcript) return;
      const project = isAssistant(m.sessionId) ? ASSISTANT_PROJECT_NAME : m.projectName;
      if (!project) return;
      followed.set(m.sessionId, {
        chatId: m.sessionId, project, transcript, text: "", open: true, overflowed: false, startedAt: now().getTime(),
      });
    }),
    lifecycle.on("stream", ({ sessionId, event }) => {
      const e = event as { type?: string; content?: unknown; parentToolUseId?: string };
      // Status lines and notes between turns say nothing about one running.
      if (!e.parentToolUseId && e.type && TURN_CONTENT.has(e.type)) running.add(sessionId);
      const f = followed.get(sessionId);
      if (!f?.open) return;
      // A subagent's text is not the answer; neither is thinking, which may come first.
      if (e.parentToolUseId || e.type === "thinking") return;
      if (e.type !== "text" || typeof e.content !== "string") {
        if (f.text.trim() && e.type && ENDS_FIRST_TEXT.has(e.type)) f.open = false;
        return;
      }
      f.text += e.content;
      if (f.text.trimStart().includes("\n")) f.open = false;
      else if (f.text.length >= MAX_CAPTURE) { f.open = false; f.overflowed = true; }
    }),
    lifecycle.on("migrated", ({ oldSessionId, newSessionId }) => {
      if (running.delete(oldSessionId)) running.add(newSessionId);
      const f = followed.get(oldSessionId);
      if (!f) return;
      followed.delete(oldSessionId);
      followed.set(newSessionId, f);
    }),
    lifecycle.on("turn_ended", (t) => {
      if (t.turnStillRunning) return;
      running.delete(t.sessionId);
      const f = followed.get(t.sessionId);
      followed.delete(t.sessionId);
      if (!f || t.outcome !== "done" || f.overflowed) return;
      if (now().getTime() - f.startedAt > FOLLOW_TTL_MS) return;
      const understood = splitUnderstoodLine(f.text);
      if (!understood) return;
      defer(() => learnFromUnderstood(f.project, f.transcript, understood.pairs, now(), f.chatId));
    }),
  ];
  return () => {
    for (const off of offs) off();
    followed.clear();
    running.clear();
  };
}

/** Counts the pairs toward learned words when self-learning and its chat part are on. */
export function learnFromUnderstood(project: string, transcript: string, pairs: readonly UnderstoodPair[], at = new Date(), chatId?: string): void {
  try {
    const settings = readVoiceSettings();
    if (!selfLearningOn(settings) || !settings.learn_from_chat) return;
    const known = new Set(vocabularyOf(settings, project).map((w) => w.toLowerCase()));
    const found = chatReplacements(transcript, pairs, known);
    if (!found.length) return;
    const learned = recordCleanupReplacements(project, found, known, at, "chat", chatId);
    // Counts only: what was said never goes into the log.
    if (learned.length) log.info(`learned ${learned.length} word(s) from the chat's reading for project "${project}"`);
  } catch (e) {
    log.warn(`could not count the chat's reading of a voice message: ${(e as Error).message}`);
  }
}
