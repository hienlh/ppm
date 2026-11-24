/**
 * Self-learning from the chat itself: after a turn that answered a voice message sent as heard,
 * the line the AI opened with — "Hiểu là: BPM → PPM" (`voice-understood.ts`), which the
 * voice-hints block asks for — is counted pair by pair toward a learned word, like the clean-up's
 * corrections are. No model call: the AI already wrote the line while answering.
 *
 * Listens on the chat lifecycle, so it works with no browser open and for Telegram too. A turn is
 * followed only when its message is the user's own (`ws` or `telegram`, not a script through the
 * socket) and carries a server-written hints block, i.e. it went as heard. The AI's line is its
 * own guess, so three guards keep a wrong one from teaching: the heard side must be in the
 * transcript and the meant side must not, a pair must be read the same way in three separate
 * messages, and the learned word fades after 30 unused days (source `chat`) or is undone in
 * Settings, after which it is never learned again until restored.
 */
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project.ts";
import { decodeMessageBlocks } from "../../shared/chat-message-blocks.ts";
import { redactLogText } from "../../shared/log-redact.ts";
import { splitVoiceMessage } from "../../shared/voice-message.ts";
import { splitUnderstoodLine, type UnderstoodPair } from "../../shared/voice-understood.ts";
import { isAssistantSession } from "../assistant/assistant-session.ts";
import { chatLifecycle, type ChatLifecycle } from "../chat-control/chat-lifecycle.ts";
import { createLogger } from "../logger.ts";
import { CLEANUP_LEARN_LIMITS, replacementKind, type Replacement } from "./voice-learn-from-cleanup.ts";
import { wordUsedIn } from "./voice-learned-fade.ts";
import { recordCleanupReplacements } from "./voice-learned-store.ts";
import { readVoiceSettings, selfLearningOn, vocabularyOf } from "./voice-settings.ts";

const log = createLogger("voice-learning");

/** How much of the answer's first text is kept to find the line in: the line is short. */
const MAX_CAPTURE = 600;

interface Followed {
  project: string;
  transcript: string;
  /** The answer's first top-level text, as it streamed. */
  text: string;
  /** Still collecting: until the first line ended, another kind of event came, or the cap. */
  open: boolean;
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
}

/** Starts following voice turns; the returned function stops it. */
export function startVoiceChatLearning(deps: VoiceChatLearningDeps = {}): () => void {
  const lifecycle = deps.lifecycle ?? chatLifecycle;
  const isAssistant = deps.isAssistant ?? ((id: string) => isAssistantSession(id));
  const now = deps.now ?? (() => new Date());
  const followed = new Map<string, Followed>();

  const offs = [
    lifecycle.on("user_message", (m) => {
      // A newer message starts a newer answer: whatever was followed for this chat is dropped.
      followed.delete(m.sessionId);
      if ((m.origin !== "ws" && m.origin !== "telegram") || m.traceOrigin) return;
      const decoded = decodeMessageBlocks(m.text);
      if (!decoded.voiceHints) return;
      const transcript = splitVoiceMessage(decoded.content).voice?.transcript.trim();
      if (!transcript) return;
      const project = isAssistant(m.sessionId) ? ASSISTANT_PROJECT_NAME : m.projectName;
      if (!project) return;
      followed.set(m.sessionId, { project, transcript, text: "", open: true });
    }),
    lifecycle.on("stream", ({ sessionId, event }) => {
      const f = followed.get(sessionId);
      if (!f?.open) return;
      const e = event as { type?: string; content?: unknown; parentToolUseId?: string };
      // A subagent's text is not the answer; neither is thinking, which may come first.
      if (e.parentToolUseId || e.type === "thinking") return;
      if (e.type !== "text" || typeof e.content !== "string") {
        // A tool call or anything else after text has begun ends the first text.
        if (f.text.trim()) f.open = false;
        return;
      }
      f.text += e.content;
      const body = f.text.trimStart();
      if ((body && body.includes("\n")) || f.text.length >= MAX_CAPTURE) f.open = false;
    }),
    lifecycle.on("migrated", ({ oldSessionId, newSessionId }) => {
      const f = followed.get(oldSessionId);
      if (!f) return;
      followed.delete(oldSessionId);
      followed.set(newSessionId, f);
    }),
    lifecycle.on("turn_ended", (t) => {
      if (t.turnStillRunning) return;
      const f = followed.get(t.sessionId);
      followed.delete(t.sessionId);
      if (!f || t.outcome !== "done") return;
      const understood = splitUnderstoodLine(f.text);
      if (!understood) return;
      learnFromUnderstood(f.project, f.transcript, understood.pairs, now());
    }),
  ];
  return () => {
    for (const off of offs) off();
    followed.clear();
  };
}

/** Counts the pairs toward learned words when self-learning and its chat part are on. */
export function learnFromUnderstood(project: string, transcript: string, pairs: readonly UnderstoodPair[], at = new Date()): void {
  try {
    const settings = readVoiceSettings();
    if (!selfLearningOn(settings) || !settings.learn_from_chat) return;
    const known = new Set(vocabularyOf(settings, project).map((w) => w.toLowerCase()));
    const found = chatReplacements(transcript, pairs, known);
    if (!found.length) return;
    const learned = recordCleanupReplacements(project, found, known, at, "chat");
    // Counts only: what was said never goes into the log.
    if (learned.length) log.info(`learned ${learned.length} word(s) from the chat's reading for project "${project}"`);
  } catch (e) {
    log.warn(`could not count the chat's reading of a voice message: ${(e as Error).message}`);
  }
}
