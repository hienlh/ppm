/**
 * An in-memory {@link CollabEnv} for the session tools' unit tests: sessions, links, pair counts,
 * cards and deliveries all live in plain maps, so a test states the world and reads what the tool did.
 */
import { SESSION_COLLAB_DEFAULTS, type SessionCollabSettings } from "../../../src/shared/session-collab-settings.ts";
import {
  permissionRank, type SessionCollabAnswer, type SessionCollabApprovalInput, type SessionCreatedEvent, type SessionDelivery,
} from "../../../src/shared/session-collab.ts";
import type { CollabEnv, LiveSessionState } from "../../../src/services/session-collab/collab-context.ts";
import { createCollabWaits } from "../../../src/services/session-collab/collab-waits.ts";
import { createCollabUnread } from "../../../src/services/session-collab/collab-unread.ts";
import type { DeliverToSessionInput } from "../../../src/server/ws/chat-inject.ts";

export const PROJECT_PATH = process.platform === "win32" ? "C:\\work\\app" : "/work/app";
export const OTHER_PATH = process.platform === "win32" ? "C:\\work\\other" : "/work/other";

export interface FakeSession {
  providerId: "claude" | "codex";
  /** Absent for a session PPM has no record of (one only a provider's own files know). */
  projectPath?: string;
  title?: string;
  mode?: string | null;
  model?: string | null;
  design?: boolean;
  live?: Partial<LiveSessionState> | null;
  parent?: string | null;
  depth?: number;
}

export function fakeEnv(opts: {
  sessions: Record<string, FakeSession>;
  settings?: Partial<SessionCollabSettings>;
  answers?: Array<SessionCollabAnswer | "timeout">;
  delivered?: SessionDelivery;
  providerDefaultMode?: string | null;
  running?: string[];
  /** PPM Assistant sessions, and those of them in an unattended turn. */
  assistants?: string[];
  unattended?: string[];
  /** The mode a message would run in, per target; changed by `onApprove` to model a mode switch. */
  chatModes?: Record<string, string>;
  /** Runs after each card is answered, before the tool goes on. */
  onApprove?: () => void;
}) {
  const sessions = opts.sessions;
  const asked: SessionCollabApprovalInput[] = [];
  const deliveries: DeliverToSessionInput[] = [];
  const created: string[] = [];
  const announced: string[] = [];
  const createdEvents: Array<Omit<SessionCreatedEvent, "type">> = [];
  const pairs = new Map<string, { auto: number; extra: number }>();
  const allowCreate = new Set<string>();
  const allowEscalation = new Map<string, number>();
  const unread = createCollabUnread({ canonical: (id) => id });
  const starting = new Set<string>();
  let reserved = 0;
  const pairKey = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);
  const answers = [...(opts.answers ?? [])];
  let nextId = 1;
  let nextMessage = 1;

  const waits = createCollabWaits({
    canonical: (id) => id,
    isIdle: (id) => (sessions[id]?.live?.phase ?? "idle") === "idle",
    graceMs: 5,
  });

  const env: CollabEnv = {
    settings: () => ({ ...SESSION_COLLAB_DEFAULTS, ...opts.settings }),
    canonical: (id) => id,
    live: (id) => {
      const s = sessions[id];
      if (!s?.live) return null;
      return { providerId: s.providerId, projectPath: s.projectPath, projectName: s.projectPath === PROJECT_PATH ? "app" : "other", phase: "idle", waitingFor: null, ...s.live };
    },
    storedPermissionMode: (id) => sessions[id]?.mode ?? null,
    providerDefaultPermissionMode: () => opts.providerDefaultMode ?? null,
    storedModel: (id) => sessions[id]?.model ?? null,
    storedProjectPath: (id) => sessions[id]?.projectPath ?? null,
    storedProvider: (id) => sessions[id]?.providerId ?? null,
    isDesignSession: (id) => !!sessions[id]?.design,
    projectNameOf: (path) => (path === PROJECT_PATH ? "app" : path === OTHER_PATH ? "other" : null),
    title: (id) => sessions[id]?.title ?? null,
    providerExists: (id) => id === "claude" || id === "codex",
    links: {
      parentOf: (id) => sessions[id]?.parent ?? null,
      depthOf: (id) => sessions[id]?.depth ?? 0,
      childrenOf: (id) => Object.keys(sessions).filter((k) => sessions[k]!.parent === id),
      recordSpawn: (child, parent, at) => {
        const depth = at ?? (sessions[parent]?.depth ?? 0) + 1;
        sessions[child] = { ...sessions[child]!, parent, depth };
        return depth;
      },
      linked: (id) => Object.keys(sessions).filter((k) => sessions[k]!.parent === id || sessions[id]?.parent === k),
    },
    pairs: {
      count: (a, b) => pairs.get(pairKey(a, b))?.auto ?? 0,
      remaining: (a, b, limit) => {
        const p = pairs.get(pairKey(a, b));
        return Math.max(0, limit + (p?.extra ?? 0) - (p?.auto ?? 0));
      },
      record: (a, b) => {
        const p = pairs.get(pairKey(a, b)) ?? { auto: 0, extra: 0 };
        p.auto++;
        pairs.set(pairKey(a, b), p);
        return p.auto;
      },
      unrecord: (a, b) => {
        const p = pairs.get(pairKey(a, b));
        if (p && p.auto > 0) p.auto--;
      },
      grant: (a, b, n) => {
        const p = pairs.get(pairKey(a, b)) ?? { auto: 0, extra: 0 };
        p.extra += n;
        pairs.set(pairKey(a, b), p);
      },
      setAllowCreate: (id) => { allowCreate.add(id); },
      canCreateWithoutAsking: (id) => allowCreate.has(id),
      setAllowEscalation: (a, b, mode) => { allowEscalation.set(`${a}>${b}`, permissionRank(mode)); },
      escalationAllowed: (a, b, mode) => {
        const rank = allowEscalation.get(`${a}>${b}`);
        return rank !== undefined && permissionRank(mode) <= rank;
      },
    },
    isAssistantSession: (id) => (opts.assistants ?? []).includes(id),
    isUnattendedTurn: (id) => (opts.unattended ?? []).includes(id),
    projectByName: (name) => (name === "app" ? { name, path: PROJECT_PATH } : name === "other" ? { name, path: OTHER_PATH } : null),
    chatMode: (id) => ({ mode: opts.chatModes?.[id] ?? sessions[id]?.mode ?? "bypassPermissions", source: sessions[id]?.mode ? "stored" : "provider-default" }),
    approve: async (_sessionId, input) => {
      asked.push(input);
      opts.onApprove?.();
      const answer = answers.shift() ?? "deny";
      if (answer === "timeout") return { allowed: false, reason: "timeout", message: "The user did not answer." };
      if (answer === "deny") return { allowed: false, reason: "denied", message: "The user said no." };
      return { allowed: true, answer };
    },
    waits,
    runningSpawned: () => [...(opts.running ?? []), ...starting],
    reservedSpawnSlots: () => reserved,
    reserveSpawnSlot: () => {
      reserved++;
      let held = true;
      return () => { if (held) { held = false; reserved--; } };
    },
    markStarting: (id) => { starting.add(id); },
    deliver: async (input) => {
      deliveries.push(input);
      return {
        delivered: opts.delivered ?? "started", targetSessionId: input.targetSessionId,
        clientMessageId: `session-${nextMessage++}`, content: input.body,
      };
    },
    createSession: async (providerId, input) => {
      const id = `child-session-${nextId++}`;
      // A real create awaits the provider: overlapping creates interleave here.
      await new Promise((r) => setTimeout(r, 1));
      sessions[id] = { providerId: providerId as "claude" | "codex", projectPath: input.projectPath, title: input.title };
      created.push(id);
      return id;
    },
    persistChild: (id, input) => {
      sessions[id] = { ...sessions[id]!, title: input.title, mode: input.permissionMode, model: input.model };
    },
    nameInProvider: () => {},
    currentTurnRef: async () => null,
    announceCreated: (event) => { announced.push(`created:${event.sessionId}`); createdEvents.push(event); },
    announceLinks: (_project, ids) => { announced.push(`links:${ids.join(",")}`); },
    unread,
  };
  return { env, asked, deliveries, created, announced, createdEvents, starting, waits, unread, reservedSlots: () => reserved };
}

/** The text of a tool result. */
export const textOf = (result: Record<string, unknown>): string =>
  ((result.content as Array<{ text: string }>)[0]!).text;
