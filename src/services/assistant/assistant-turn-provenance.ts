/**
 * How each PPM Assistant turn started, and whether text from anyone but the user reached it, as
 * the server saw it — the source of the provenance block on every message the Assistant sends a
 * manager chat. Nothing here is read from what the Assistant's AI wrote.
 *
 * A turn is everything from the message that opened it to the chat's `turn_ended`. Its starter is
 * fixed by that first message: the user in PPM, the user on Telegram, or PPM itself (a watch
 * report, a scheduled script) — and a turn PPM began keeps "PPM" even after the user types into
 * it. It is marked untrusted, with the reason, when it carried watch news, a forwarded Telegram
 * message or a scheduled script's text, or when the Assistant ran a tool in it that can bring outside
 * text — a file read or search, a shell command, a git, schedule or tunnel read, another chat or a
 * tab (`assistant-outside-text.ts`: every tool but a short allowlist).
 */
import { chatLifecycle } from "../chat-control/chat-lifecycle.ts";
import { chatControl, type ChatMessageOrigin } from "../chat-control/chat-control.ts";
import { decodeMessageBlocks } from "../../shared/chat-message-blocks.ts";
import { normalizeOpening, type AssistantProvenance, type ProvenanceStartedBy } from "../../shared/assistant-provenance.ts";
import type { TraceOrigin } from "../../shared/session-trace.ts";
import { hasForwardedPart } from "../assistant-telegram/assistant-telegram-inbound-text.ts";
import { isAssistantSession } from "./assistant-session.ts";
import { toolUseBringsOutsideText } from "./assistant-outside-text.ts";

export type UntrustedReason = "news" | "forwarded" | "read" | "scheduled" | "digest" | "late_reply" | "unknown";

interface TurnRecord {
  startedBy: ProvenanceStartedBy;
  opening?: string;
  reasons: Set<UntrustedReason>;
}

export interface TurnProvenanceDeps {
  isAssistant(sessionId: string): boolean;
  /** Whose message the session's running turn belongs to, from the live chat; undefined when none. */
  liveOrigin(sessionId: string): ChatMessageOrigin | undefined;
}

const startedByOrigin = (origin: ChatMessageOrigin | undefined, scripted: boolean): ProvenanceStartedBy =>
  scripted ? "ppm" : origin === "ws" ? "user_ppm" : origin === "telegram" ? "user_telegram" : "ppm";

export function createTurnProvenanceTracker(deps: TurnProvenanceDeps) {
  const turns = new Map<string, TurnRecord>();

  function recordFor(sessionId: string): TurnRecord {
    let rec = turns.get(sessionId);
    if (!rec) {
      // A mark without a message seen first (a restart mid-turn): the live chat says who started it.
      rec = { startedBy: startedByOrigin(deps.liveOrigin(sessionId), false), reasons: new Set(["unknown"]) };
      turns.set(sessionId, rec);
    }
    return rec;
  }

  function markUntrusted(sessionId: string, reason: UntrustedReason): void {
    if (!deps.isAssistant(sessionId)) return;
    const rec = recordFor(sessionId);
    rec.reasons.delete("unknown");
    rec.reasons.add(reason);
  }

  return {
    /** A message entered a chat: the opening one of an Assistant turn fixes who started it. */
    noteMessage(m: { sessionId: string; text: string; origin: ChatMessageOrigin; traceOrigin?: TraceOrigin }): void {
      if (m.origin === "session" || !deps.isAssistant(m.sessionId)) return;
      const scripted = !!m.traceOrigin;
      let rec = turns.get(m.sessionId);
      if (!rec) {
        rec = { startedBy: startedByOrigin(m.origin, scripted), reasons: new Set() };
        turns.set(m.sessionId, rec);
      }
      if (m.origin === "watch") rec.reasons.add("news");
      if (scripted) rec.reasons.add("scheduled");
      if (scripted || (m.origin !== "ws" && m.origin !== "telegram")) return;
      const body = decodeMessageBlocks(m.text).content;
      if (m.origin === "telegram" && hasForwardedPart(body)) {
        // Someone else's words: never quoted as the user's opening.
        rec.reasons.add("forwarded");
        return;
      }
      if (!rec.opening) {
        const opening = normalizeOpening(body);
        if (opening) rec.opening = opening;
      }
    },

    /** Text from outside the user reached the session's running turn. */
    markUntrusted,

    /**
     * The provider is about to run a tool in the session's turn. A file read, a search, a shell
     * command, a web fetch or a subagent can each bring outside text, so the turn is marked
     * before the result comes back; PPM's own tools are judged by their endpoints instead.
     */
    noteToolUse(sessionId: string, event: unknown): void {
      const e = event as { type?: unknown; tool?: unknown } | null;
      if (!e || e.type !== "tool_use" || typeof e.tool !== "string") return;
      if (toolUseBringsOutsideText(e.tool)) markUntrusted(sessionId, "read");
    },

    turnEnded(sessionId: string): void {
      turns.delete(sessionId);
    },

    migrated(from: string, to: string): void {
      const rec = turns.get(from);
      if (!rec) return;
      turns.delete(from);
      turns.set(to, rec);
    },

    /** The provenance block for a message the session sends now. Unknown means untrusted. */
    provenance(sessionId: string): AssistantProvenance {
      const rec = turns.get(sessionId) ?? {
        startedBy: startedByOrigin(deps.liveOrigin(sessionId), false), reasons: new Set<UntrustedReason>(["unknown"]),
      };
      const reasons = [...rec.reasons].sort();
      return {
        startedBy: rec.startedBy,
        ...(rec.opening ? { opening: rec.opening } : {}),
        untrusted: reasons.length > 0,
        ...(reasons.length ? { reason: reasons.join(", ") } : {}),
      };
    },
  };
}

export type TurnProvenanceTracker = ReturnType<typeof createTurnProvenanceTracker>;

export const assistantTurnProvenance = createTurnProvenanceTracker({
  isAssistant: (sessionId) => isAssistantSession(sessionId),
  liveOrigin: (sessionId) => chatControl()?.liveState(sessionId)?.turnOrigin,
});

chatLifecycle.on("user_message", (m) => assistantTurnProvenance.noteMessage(m));
chatLifecycle.on("stream", (s) => assistantTurnProvenance.noteToolUse(s.sessionId, s.event));
chatLifecycle.on("turn_ended", (e) => assistantTurnProvenance.turnEnded(e.sessionId));
chatLifecycle.on("migrated", (e) => assistantTurnProvenance.migrated(e.oldSessionId, e.newSessionId));
