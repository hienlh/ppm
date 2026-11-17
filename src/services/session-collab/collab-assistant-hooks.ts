import type { AssistantProvenance } from "../../shared/assistant-provenance.ts";
import type { AssistantSendGuards } from "./assistant-send-guards.ts";

/**
 * What the session tools need from PPM for the PPM Assistant working through manager chats. All
 * optional, so an environment without the Assistant (or a test of an ordinary session) has none,
 * and without them every Assistant message and create keeps asking on a card.
 */
export interface AssistantCollabHooks {
  /** The manager chat of the project at `projectPath`, by canonical session id; null when it has none. */
  managerOf?(projectPath: string): string | null;
  /** Every manager chat, as the Assistant's status and its context list them. */
  managers?(): Array<{ projectName: string; projectPath: string; sessionId: string }>;
  /**
   * How the Assistant session's running turn started, as PPM saw it, for a message to a chat of
   * `recipient`'s project (which decides whether PPM's restart news lets it ask for a resume).
   */
  turnProvenance?(sessionId: string, recipient?: { projectName: string }): AssistantProvenance;
  /**
   * Text PPM itself put into the restart news the Assistant session's running wake turn carries,
   * for chats of `projectName` (titles, prompts, background task descriptions and commands): what a
   * message from that turn to that project's manager may quote without reading as a secret. Empty
   * outside such a turn.
   */
  restartNewsText?(assistantSessionId: string, projectName: string): string[];
  /** Another AI's words reached the Assistant session's running turn (a status, a reply). */
  markUntrusted?(sessionId: string, reason: "read"): void;
  /** Budgets, duplicates and quiet hours for the Assistant's messages to manager chats. */
  assistantGuards?: AssistantSendGuards;
  /** The mode a manager chat PPM creates starts in. */
  managerDefaultMode?(): string;
  /**
   * Makes the chat its project's manager, assigned by the Assistant, with its rules files ensured.
   * Throws when the project got a manager meanwhile: the Assistant never replaces one.
   */
  assignManager?(projectName: string, sessionId: string): Promise<void>;
  /** Writes a server event to the session's trace. Never throws. */
  trace?(sessionId: string, type: string, payload: Record<string, unknown>): void;
  /**
   * The Assistant's message reached a manager chat and nothing claimed that chat's answer (no wait,
   * or a wait that ended before the answer): the answer comes back later as wake news. `queued`
   * when the message waits for the turn running now, whose end is not the answer.
   */
  managerAsked?(assistantSessionId: string, managerSessionId: string, projectName: string, queued: boolean): void;
}
