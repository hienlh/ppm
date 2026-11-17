/**
 * `/tasks` decks: which open tasks a deck holds, in "what to do first" order, and the facts each
 * card shows. A deck is a snapshot taken when `/tasks` is sent (or a project filter pressed): its
 * task ids and where the user is in it live in memory, beside the button codes, and are gone after
 * a restart like the codes are ("send /tasks again").
 *
 * Only projects with the task store switched on are read; a task whose project was switched off,
 * or that was deleted, drops out of the deck when it comes up.
 */
import { basename } from "node:path";
import { ME_MEMBER_ID, type TaskView } from "../../shared/ppm-tasks.ts";
import { formatTaskRef } from "../../shared/ppm-tasks-refs.ts";
import { taskLinkWebHref } from "../../shared/ppm-task-link-href.ts";
import { projectTelegramDetail } from "../assistant-managers/manager-chats-db.ts";
import { projectNameForPath } from "../project-name-for-path.ts";
import { memberRows } from "../ppm-tasks/ppm-tasks-db.ts";
import { taskLinkStateSource } from "../ppm-tasks/ppm-tasks-link-state-source.ts";
import { jiraSiteFor } from "../ppm-tasks/link-state/ppm-tasks-jira-site.ts";
import { listStatuses } from "../ppm-tasks/ppm-tasks-project-config.ts";
import { getTaskProject, listTaskProjects } from "../ppm-tasks/ppm-tasks-projects.service.ts";
import { getTask, listTasks, taskChildren } from "../ppm-tasks/ppm-tasks.service.ts";
import { todayYmd, userTimeZone } from "../ppm-tasks/ppm-tasks-today.ts";
import type { CardDetail } from "./assistant-telegram-card-kinds.ts";
import type { ChildLine, TaskCardFacts, TaskCardLinkLine } from "./assistant-telegram-task-card.ts";
import { waitingDetail } from "../../shared/ppm-tasks-waiting.ts";

/** Most decks held at once; the oldest goes first. */
export const MAX_DECKS = 100;
/** Most tasks one deck holds. */
export const DECK_MAX_TASKS = 200;

export interface TaskProjectChoice {
  projectKey: string;
  name: string;
}

/** The projects with Tasks on, by name, for the filter row and `/tasks <project>`. */
export function enabledTaskProjects(): TaskProjectChoice[] {
  return listTaskProjects({ enabledOnly: true })
    .map((p) => ({ projectKey: p.projectKey, name: projectNameForPath(p.projectPath) ?? basename(p.projectPath) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function taskProjectName(projectKey: string): string {
  const path = getTaskProject(projectKey)?.projectPath ?? projectKey;
  return projectNameForPath(path) ?? basename(path);
}

/** `/tasks nxsys`: the project named, by its PPM name or key, case-insensitively; null when none. */
export function findTaskProject(asked: string, projects: readonly TaskProjectChoice[]): TaskProjectChoice | null {
  const q = asked.trim().toLowerCase();
  return projects.find((p) => p.name.toLowerCase() === q) ?? projects.find((p) => p.projectKey.toLowerCase() === q) ?? null;
}

/** The open tasks of the filter's project (or of every project with Tasks on), in order. */
export function deckTaskIds(projectKey: string | null): string[] {
  return listTasks({ ...(projectKey ? { projectKeys: [projectKey] } : {}), limit: DECK_MAX_TASKS }).map((t) => t.id);
}

/**
 * A project's detail level on Telegram. A project PPM has no setting for shows titles only, as the
 * Assistant's cards do: the safe side for work whose details must not reach a phone.
 */
export function taskDetail(projectKey: string): CardDetail {
  try {
    return projectTelegramDetail(projectKey) ?? "title";
  } catch {
    return "title";
  }
}

/** A task that may still be shown: not deleted, in a project with Tasks on. */
export function showableTask(taskId: string): TaskView | null {
  const task = getTask(taskId);
  if (!task || task.deletedAt !== null) return null;
  return getTaskProject(task.projectKey)?.enabled ? task : null;
}

function memberName(projectKey: string, id: string | null): string | null {
  if (!id) return null;
  const found = memberRows(projectKey).find((m) => m.id === id);
  if (found) return found.name;
  return id === ME_MEMBER_ID ? "You" : null;
}

type LinkStates = ReturnType<ReturnType<typeof taskLinkStateSource>["states"]>;

/**
 * A Jira or PR link's live state as one line, opening the issue or the PR; nothing is fetched
 * here, only the cache is read.
 */
export function linkLines(task: TaskView): TaskCardLinkLine[] {
  const links = task.links.filter((l) => l.kind === "jira" || l.kind === "pr");
  if (!links.length) return [];
  let states: LinkStates;
  try {
    states = taskLinkStateSource().states(task.projectKey, links);
  } catch {
    states = [];
  }
  const jiraSite = links.some((l) => l.kind === "jira") ? jiraSiteFor(task.projectKey) : null;
  return links.map((l) => ({ text: linkText(l, states), href: taskLinkWebHref(l, { jiraSite }) }));
}

/** "NX-6318 In Progress", "PR #2231 open · CI failing". */
function linkText(l: TaskView["links"][number], states: LinkStates): string {
  const s = states.find((x) => x.kind === l.kind && x.ref === l.ref)?.state as Record<string, unknown> | null | undefined;
  if (l.kind === "jira") return typeof s?.status === "string" ? `${l.ref} ${s.status}` : l.ref;
  const number = /#(\d+)$/.exec(l.ref)?.[1];
  const name = number ? `PR #${number}` : `PR ${l.ref}`;
  if (!s || typeof s.state !== "string") return `${name} · state unknown`;
  const checks = s.checks as { total?: number; failing?: number; pending?: number } | undefined;
  const ci = !checks?.total ? null : checks.failing ? "CI failing" : checks.pending ? "CI running" : "CI passing";
  return [`${name} ${s.state}`, ci].filter(Boolean).join(" · ");
}

/** The facts a card shows for this task. */
export function taskFacts(task: TaskView): TaskCardFacts {
  const projectName = taskProjectName(task.projectKey);
  const status = listStatuses(task.projectKey).find((s) => s.id === task.statusId);
  return {
    ref: formatTaskRef(task.number, projectName),
    projectName,
    title: task.title,
    type: task.type,
    statusName: status?.name ?? "Unknown status",
    closed: task.baseGroup === "closed",
    urgency: task.effectiveUrgency,
    urgencyRaised: task.urgencyRaised,
    importance: task.importance,
    dueDate: task.dueDate,
    assignee: memberName(task.projectKey, task.assigneeMemberId),
    waiting: waitingDetail({ ...task, statusName: status?.name ?? null }, (id) => memberName(task.projectKey, id)),
    nextStep: task.nextStep,
    linkLines: linkLines(task),
  };
}

/** The task's children that are still open, as listed under "Show open children". */
export function openChildren(taskId: string): ChildLine[] {
  const children = taskChildren(taskId).filter((c) => c.baseGroup !== "closed" && c.deletedAt === null);
  if (!children.length) return [];
  const projectName = taskProjectName(children[0]!.projectKey);
  const statuses = listStatuses(children[0]!.projectKey);
  return children.map((c) => ({
    ref: formatTaskRef(c.number, projectName), title: c.title,
    statusName: statuses.find((s) => s.id === c.statusId)?.name ?? "Unknown status",
  }));
}

/** "14:02" in the user's time zone. */
export function clockTime(at: number): string {
  const format = (timeZone?: string) => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
  try {
    return format(userTimeZone());
  } catch {
    return format(undefined);
  }
}

export { todayYmd };

/** The status press waiting for an Undo: enough to put the status back if nothing changed since. */
export interface StatusUndo {
  taskId: string;
  title: string;
  fromStatusId: string;
  /** The task's revision right after the press; any other means someone changed it since. */
  revisionAfter: number;
}

/** What the deck's message shows now, so a press on it is checked against what was seen. */
export type ResultView = {
  kind: "result"; taskId: string; askTell: boolean;
  change: { from: string; to: string; at: string; openChildren: number; managerLine?: string };
};
export type DeckView =
  /** `note`: PPM's own words above the card ("Changed elsewhere"). */
  | { kind: "card"; taskId: string; revision: number; note?: string }
  | ResultView
  | { kind: "children"; taskId: string; back: ResultView }
  /** `finished`: the user went through every task, rather than the deck holding none. */
  | { kind: "empty"; finished: boolean };

export interface Deck {
  id: string;
  chatId: string;
  messageId: number | null;
  /** The project filter; null is "All". */
  projectKey: string | null;
  taskIds: string[];
  index: number;
  view: DeckView;
  /** The last status press, offered as Undo until the next one. */
  undo: StatusUndo | null;
  /** Tasks the user was already asked "Tell manager now?" about in this deck: asked once per task. */
  asked: Set<string>;
  /** Cancels the pending auto-advance. */
  cancelAdvance: (() => void) | null;
  /** Bumped on every render, so its buttons get a group of their own. */
  seq: number;
}

/** The decks open now, oldest first. */
export class DeckStore {
  private readonly decks = new Map<string, Deck>();

  /** `onEvicted`: a deck pushed out by the cap, so its buttons can go too. */
  constructor(private readonly onEvicted: (deck: Deck) => void = () => {}) {}

  create(chatId: string, projectKey: string | null): Deck {
    while (this.decks.size >= MAX_DECKS) {
      const gone = this.drop(this.decks.keys().next().value!);
      if (gone) this.onEvicted(gone);
    }
    const deck: Deck = {
      id: crypto.randomUUID().slice(0, 12), chatId, messageId: null, projectKey, taskIds: deckTaskIds(projectKey), index: 0,
      view: { kind: "empty", finished: false }, undo: null, asked: new Set(), cancelAdvance: null, seq: 0,
    };
    this.decks.set(deck.id, deck);
    return deck;
  }

  /** The task the deck at this message shows now (a card, a status result, its children). */
  taskAt(chatId: string, messageId: number): string | null {
    for (const deck of this.decks.values()) {
      if (deck.chatId === chatId && deck.messageId === messageId) return deck.view.kind === "empty" ? null : deck.view.taskId;
    }
    return null;
  }

  get(id: string, chatId: string): Deck | null {
    const deck = this.decks.get(id);
    return deck && deck.chatId === chatId ? deck : null;
  }

  /** The deck dropped with its pending auto-advance; returns it so its buttons can go too. */
  drop(id: string): Deck | null {
    const deck = this.decks.get(id) ?? null;
    deck?.cancelAdvance?.();
    this.decks.delete(id);
    return deck;
  }

  dropChat(chatId: string): Deck[] {
    const gone = [...this.decks.values()].filter((d) => d.chatId === chatId);
    for (const d of gone) this.drop(d.id);
    return gone;
  }

  clear(): void {
    for (const id of [...this.decks.keys()]) this.drop(id);
  }

  get size(): number {
    return this.decks.size;
  }
}
