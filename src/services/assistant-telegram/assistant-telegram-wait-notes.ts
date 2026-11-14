/**
 * A line in a bound Assistant turn's Telegram draft while the turn sits in a `send_to_session` or
 * `create_session` call with `wait: true`. Such a wait can run for minutes with nothing streaming,
 * and the phone then shows a bare "…" that reads as a hung bot. After {@link WAIT_NOTE_AFTER_MS} the
 * draft says whom the turn is waiting for; the line goes when the call returns.
 *
 * It is an edit of the turn's own draft, never a new message: Telegram notifies nobody about an
 * edit, so it cannot buzz a phone in quiet hours, and it adds one coalesced edit per wait to the
 * chat's send lane (the turn's draft key), nothing to any send budget. A turn PPM started on its
 * own is held by the wake gate and never reaches here. The chat's name is read from PPM's
 * database when the timer fires, off the chat's hot path.
 */
import { CREATE_SESSION_TOOL, SEND_TO_SESSION_TOOL } from "../../shared/session-collab.ts";
import { getSessionProjectName, getSessionTitle } from "../db.service.ts";
import { truncateText } from "../notification-format.ts";
import { redactForTelegram } from "../telegram/telegram-html-format.ts";
import { shortToolName } from "./assistant-telegram-turn-renderer.ts";

/** How long a waiting call runs before the draft says so. */
export const WAIT_NOTE_AFTER_MS = 30_000;
const NAME_MAX = 60;

/** Where a note is shown: the live renderers of the turn, at the moment the timer fires. */
export interface WaitNoteTarget {
  waiting(note: string | null): void;
}

export interface WaitNotesDeps {
  /** The live renderers of a session's current turn. */
  renderers(sessionId: string): WaitNoteTarget[];
  /** A chat as the note names it, plain text; null when PPM does not know it. */
  describeChat?: (sessionId: string) => string | null;
  afterMs?: number;
  setTimer?: (fn: () => void, ms: number) => () => void;
}

function realDescribe(sessionId: string): string | null {
  const title = getSessionTitle(sessionId)?.replace(/\s+/g, " ").trim();
  const project = getSessionProjectName(sessionId);
  if (!title) return null;
  const name = `“${truncateText(redactForTelegram(title), NAME_MAX)}”`;
  return project ? `${name} in ${truncateText(redactForTelegram(project), NAME_MAX)}` : name;
}

const realTimer = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return () => clearTimeout(t);
};

interface Pending {
  sessionId: string;
  cancel: () => void;
  /** The line shown for it, once its timer fired. */
  note: string | null;
}

export class AssistantTelegramWaitNotes {
  /** Waiting calls by tool-use id. */
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: WaitNotesDeps) {}

  /** A tool call started in a bound session's turn; a waiting session tool is timed. */
  toolStarted(sessionId: string, ev: { tool: string; input?: unknown; toolUseId?: string }): void {
    if (!ev.toolUseId || this.pending.has(ev.toolUseId)) return;
    const name = shortToolName(ev.tool);
    if (name !== SEND_TO_SESSION_TOOL && name !== CREATE_SESSION_TOOL) return;
    // Claude hands the tool its arguments as the input; Codex wraps them (`{ server, tool, arguments }`).
    const raw = (ev.input ?? {}) as { arguments?: unknown };
    const input = (raw.arguments && typeof raw.arguments === "object" ? raw.arguments : raw) as { wait?: unknown; session_id?: unknown };
    if (input.wait !== true) return;
    const target = name === SEND_TO_SESSION_TOOL && typeof input.session_id === "string" ? input.session_id : null;
    const id = ev.toolUseId;
    const entry: Pending = { sessionId, note: null, cancel: () => {} };
    entry.cancel = (this.deps.setTimer ?? realTimer)(() => {
      if (this.pending.get(id) !== entry) return;
      entry.note = this.noteFor(target);
      for (const r of this.deps.renderers(entry.sessionId)) r.waiting(entry.note);
    }, this.deps.afterMs ?? WAIT_NOTE_AFTER_MS);
    this.pending.set(id, entry);
  }

  /** A tool call returned: its note goes, or gives way to that of another wait still running. */
  toolEnded(toolUseId: string | undefined): void {
    if (!toolUseId) return;
    const entry = this.pending.get(toolUseId);
    if (!entry) return;
    this.pending.delete(toolUseId);
    entry.cancel();
    if (entry.note === null) return;
    const other = [...this.pending.values()].reverse().find((e) => e.sessionId === entry.sessionId && e.note !== null);
    for (const r of this.deps.renderers(entry.sessionId)) r.waiting(other?.note ?? null);
  }

  /** The turn is over: nothing of it is timed any more (its renderers finish without the note). */
  turnEnded(sessionId: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.sessionId !== sessionId) continue;
      entry.cancel();
      this.pending.delete(id);
    }
  }

  renamed(oldId: string, newId: string): void {
    for (const entry of this.pending.values()) if (entry.sessionId === oldId) entry.sessionId = newId;
  }

  clear(): void {
    for (const entry of this.pending.values()) entry.cancel();
    this.pending.clear();
  }

  private noteFor(target: string | null): string {
    let who: string | null = null;
    if (target) {
      try { who = (this.deps.describeChat ?? realDescribe)(target); } catch { who = null; }
    }
    return who ? `Waiting for the chat ${who} to answer…` : "Waiting for another chat to answer…";
  }
}
