/**
 * What the handed-off work checker reads and does, behind one interface so tests replay it on a
 * fake clock. The live version only looks at the child (its live state and its files) and only ever
 * talks to the manager or posts an Assistant card.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { chatControl, type LiveChatState } from "../../chat-control/chat-control.ts";
import { getSessionProjectPath, getSessionProvider, getSessionTitle } from "../../db.service.ts";
import { assistantCards } from "../../assistant-cards/assistant-cards.service.ts";
import { wakeManager, type DeliverOutcome } from "../ppm-tasks-deliver.ts";
import { ppmTasksEvents } from "../ppm-tasks-events.ts";
import { createTranscriptLocator, type TranscriptLocation } from "./child-transcript-locator.ts";
import type { AssistantCardPayload } from "../../../shared/assistant-cards.ts";

export type CardTask = NonNullable<AssistantCardPayload["tasks"]>[number];

export interface ChildCheckEnv {
  now(): number;
  liveState(sessionId: string): LiveChatState | null;
  sessionExists(sessionId: string): boolean;
  providerOf(sessionId: string): string;
  chatTitle(sessionId: string): string | null;
  /** The chat's transcript, or null when it has none yet (looked for again after `retryMs`). */
  locate(sessionId: string, providerId: string, retryMs: number): Promise<TranscriptLocation | null>;
  /** The latest write of any of the chat's subagent transcripts: work its main transcript does not show. */
  subagentActivity(dir: string): Promise<number | null>;
  wake(projectKey: string, lines: string[]): Promise<DeliverOutcome>;
  /** `tasks`: which tasks the card is about and the chat on each, for an "Open chat" per task. */
  postCard(projectKey: string, projectName: string, managerSessionId: string | null, title: string, body: string, tasks: CardTask[]): void;
  emit(projectKeys: string[]): void;
}

/** Newest mtime of the `*.jsonl` files in `dir`, read without blocking; null when there are none. */
export async function latestJsonlWrite(dir: string): Promise<number | null> {
  let names: string[];
  try { names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl")); } catch { return null; }
  let latest: number | null = null;
  for (const name of names) {
    const s = await stat(join(dir, name)).catch(() => null);
    if (s && (latest === null || s.mtimeMs > latest)) latest = s.mtimeMs;
  }
  return latest;
}

const locator = createTranscriptLocator();

export const liveChildCheckEnv: ChildCheckEnv = {
  now: () => Date.now(),
  liveState: (id) => chatControl()?.liveState(id) ?? null,
  sessionExists: (id) => getSessionProjectPath(id) !== null,
  providerOf: (id) => getSessionProvider(id) ?? "claude",
  chatTitle: (id) => getSessionTitle(id),
  async locate(id, providerId, retryMs) {
    const projectPath = getSessionProjectPath(id);
    return projectPath ? locator.locate(id, providerId, projectPath, retryMs) : null;
  },
  subagentActivity: latestJsonlWrite,
  wake: (projectKey, lines) => wakeManager(projectKey, { kind: "ppm", label: "PPM" }, lines, { unattended: true }),
  postCard(projectKey, projectName, managerSessionId, title, body, tasks) {
    assistantCards.create({ kind: "needs_decision", projectName, projectPath: null, projectKey, sessionId: managerSessionId, title, body, payload: { detected: true, tasks } });
  },
  emit: (projectKeys) => ppmTasksEvents.emit({ type: "link_states", projectKeys }),
};
