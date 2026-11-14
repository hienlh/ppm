/**
 * The session-collaboration e2e's scripted Claude, plus one race on demand: a person's turn that
 * starts between a schedule's quiet check and its send. Real typing cannot hit that window, so a
 * chat armed through `/__sched-test/race` answers its next scheduled message the way the real
 * chat would then: the follow-up lands behind a running turn (`followUpDisposition` "inserted",
 * which a `later` message turns into "queued"), the person's held turn opens first, and the
 * scheduled message waits in the provider's queue behind it — where Stop takes it down.
 */
import { decodeMessageBlocks } from "../../../src/shared/chat-message-blocks";
import type { SendMessageOpts } from "../../../src/types/chat";
import { ScriptedClaude } from "./session-collab-scripted-providers";

/** What the person's turn says: the scripted provider holds any turn whose message asks for it. */
export const RACING_TURN = "HOLD: the person's own question, typed a moment before the schedule went in.";

export class RacingScriptedClaude extends ScriptedClaude {
  private readonly armed = new Set<string>();

  /** The chat's next scheduled message finds a person's turn already running. */
  arm(sessionId: string): void {
    this.armed.add(sessionId);
  }

  followUpDisposition(sessionId: string): "inserted" | null {
    return this.armed.has(sessionId) ? "inserted" : null;
  }

  override pushMessage(sessionId: string, content: string, opts?: SendMessageOpts): boolean {
    if (!this.armed.has(sessionId) || !decodeMessageBlocks(content).scheduleRun) return super.pushMessage(sessionId, content, opts);
    this.armed.delete(sessionId);
    if (!super.pushMessage(sessionId, RACING_TURN, {})) return false;
    return super.pushMessage(sessionId, content, opts);
  }
}
