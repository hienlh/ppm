import type { ChatControl } from "../chat-control/chat-control.ts";
import { unnamedChat } from "../assistant-watch/watched-chat-title.ts";
import { resolveAssistantProject, type AssistantProject, type AssistantSessionTarget, type Scoped } from "./assistant-project-scope.ts";
import type { RecentUnpins } from "./assistant-recent-unpins.ts";

/**
 * What the chat tools know of one chat before they act on it: the project it is proven to belong
 * to (its transcript sits where that project's chats are filed), and the facts a card shows, read
 * from PPM's own records. Never from the agent's words, and read again after the user answers.
 */

export interface ChatFacts {
  /** PPM's title for the chat, else the one it last saw; null when it has none yet. */
  title: string | null;
  pinned: boolean;
  tag: { id: number; name: string } | null;
  /** The chat is a project's manager chat. */
  manager: boolean;
  /** Edited versions were branched from it, so deleting it would orphan them. */
  branched: boolean;
}

export interface ChatToolDeps {
  projects(): AssistantProject[];
  /** The chat proven to belong to `project`; Assistant sessions are refused here. */
  target(project: AssistantProject, sessionId: unknown): Scoped<AssistantSessionTarget>;
  facts(sessionId: string): Promise<ChatFacts>;
  control(): ChatControl | null;
  /** Background agents or shells are still running under the chat. */
  backgroundWork(sessionId: string): Promise<boolean>;
  /** The Assistant's own turn was started by PPM (a watch report) and nobody has written in it since. */
  unattended(assistantSessionId: string): boolean;
  unpins: RecentUnpins;
  now(): number;
}

export interface ChatTarget extends AssistantSessionTarget {
  project: AssistantProject;
  facts: ChatFacts;
  /** What the chat is called in answers and refusals. */
  name: string;
}

/** The chat `sessionId` names in `project`, with its facts. */
export async function resolveChatIn(project: AssistantProject, sessionId: unknown, deps: ChatToolDeps): Promise<Scoped<ChatTarget>> {
  const target = deps.target(project, sessionId);
  if (!target.ok) return target;
  const facts = await deps.facts(target.value.sessionId);
  return { ok: true, value: { ...target.value, project, facts, name: facts.title || unnamedChat(target.value.sessionId) } };
}

/** The registered project `args.project` names, and the chat `args.sessionId` names in it. */
export async function resolveChat(args: Record<string, unknown>, deps: ChatToolDeps): Promise<Scoped<ChatTarget>> {
  const project = resolveAssistantProject(args.project, () => deps.projects());
  if (!project.ok) return project;
  return resolveChatIn(project.value, args.sessionId, deps);
}

/** Whether the chat is mid-turn now, as the live chat registry says. */
export const isRunning = (deps: ChatToolDeps, sessionId: string): boolean => deps.control()?.liveState(sessionId)?.running === true;
