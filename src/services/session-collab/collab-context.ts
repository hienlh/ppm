import { resolve } from "node:path";
import type { SessionPhase } from "../../types/api.ts";
import type { SessionCollabSettings } from "../../shared/session-collab-settings.ts";
import type {
  SessionCollabApprovalInput, SessionCollabRefusal, SessionCreatedEvent,
} from "../../shared/session-collab.ts";
import type { TurnReference } from "../../shared/chat-turn-ref.ts";
import { SESSION_ID_RE } from "../../shared/session-turn-ids.ts";
import type { DeliverToSessionInput, DeliverToSessionResult } from "../../server/ws/chat-inject.ts";
import type { CollabApprovalOutcome } from "./collab-approval-broker.ts";
import type { CollabWaits } from "./collab-waits.ts";
import type { CollabUnread } from "./collab-unread.ts";

/**
 * What the session tools need from the rest of PPM, as one object, so the tools' rules can be
 * tested without a server: the production one is built in `collab-env.ts`. Every id going in may be
 * any id a session was known by; ids coming out are canonical.
 */

/** A session as this process knows it while it is open in the chat registry. */
export interface LiveSessionState {
  providerId: string;
  projectName?: string;
  projectPath?: string;
  phase: SessionPhase;
  permissionMode?: string;
  model?: string;
  waitingFor: "approval" | "question" | null;
  /** The last turn's answer, as the "Chat completed" notification quotes it. */
  lastAnswer?: string;
  /** Epoch ms of the last activity seen. */
  updatedAt?: number;
  /** The newest turn a message opened (`turn_started`). */
  currentTurnId?: string;
}

export interface CollabEnv {
  settings(): SessionCollabSettings;
  canonical(sessionId: string): string;
  live(sessionId: string): LiveSessionState | null;
  storedPermissionMode(sessionId: string): string | null;
  providerDefaultPermissionMode(providerId: string): string | null;
  storedModel(sessionId: string): string | null;
  storedProjectPath(sessionId: string): string | null;
  storedProvider(sessionId: string): string | null;
  isDesignSession(sessionId: string): boolean;
  projectNameOf(projectPath: string): string | null;
  title(sessionId: string): string | null;
  providerExists(providerId: string): boolean;
  links: {
    parentOf(sessionId: string): string | null;
    depthOf(sessionId: string): number;
    childrenOf(sessionId: string): string[];
    recordSpawn(childId: string, parentId: string): number;
    linked(sessionId: string): string[];
  };
  pairs: {
    remaining(a: string, b: string, limit: number): number;
    count(a: string, b: string): number;
    record(a: string, b: string): number;
    /** Takes back a message `record` counted that was never delivered. */
    unrecord(a: string, b: string): void;
    grant(a: string, b: string, n: number): void;
    setAllowCreate(sessionId: string): void;
    canCreateWithoutAsking(sessionId: string): boolean;
    /** "Allow for this session" on an escalation card, for the target in `targetMode`. */
    setAllowEscalation(sender: string, target: string, targetMode: string | null): void;
    /** Allowed, and the target runs no more permissively now than when it was allowed. */
    escalationAllowed(sender: string, target: string, targetMode: string | null): boolean;
  };
  approve(sessionId: string, input: SessionCollabApprovalInput, signal?: AbortSignal): Promise<CollabApprovalOutcome>;
  waits: CollabWaits;
  /** AI-created sessions of the project counted against the running limit. */
  runningSpawned(projectName: string): string[];
  /** Running-limit slots held by creates still in progress (see `reserveSpawnSlot`). */
  reservedSpawnSlots(projectName: string): number;
  /** Holds a running-limit slot until the returned release is called; synchronous. */
  reserveSpawnSlot(projectName: string): () => void;
  /** A created session counts as running from now until its first turn ends. */
  markStarting(childId: string, projectName: string): void;
  deliver(input: DeliverToSessionInput): Promise<DeliverToSessionResult>;
  createSession(providerId: string, input: { projectName: string; projectPath: string; title: string }): Promise<string>;
  persistChild(childId: string, input: { title: string; permissionMode: string; model: string | null; projectName: string; projectPath: string }): void;
  /** Names the session in its provider once its first turn has a transcript; never throws. */
  nameInProvider(childId: string, providerId: string, title: string, projectPath: string, clientMessageId: string): void;
  currentTurnRef(caller: CollabCaller): Promise<TurnReference | null>;
  announceCreated(event: Omit<SessionCreatedEvent, "type">): void;
  announceLinks(projectName: string, sessionIds: string[]): void;
  /** Messages from `from` that no turn of `to` has taken yet, since `to` last asked about `from`. */
  unread: Pick<CollabUnread, "add" | "take" | "peek">;
}

export interface CollabCaller {
  sessionId: string;
  providerId: "claude" | "codex";
  projectName: string;
  projectPath: string;
  title: string;
}

export interface CollabTarget {
  sessionId: string;
  providerId: "claude" | "codex";
  title: string;
}

export type Resolved<T> = { ok: true; value: T } | { ok: false; refusal: SessionCollabRefusal | "invalid"; message: string };

const isProvider = (id: unknown): id is "claude" | "codex" => id === "claude" || id === "codex";
const samePath = (a: string, b: string): boolean => {
  const x = resolve(a), y = resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
};

export const titleOf = (env: CollabEnv, sessionId: string): string => env.title(sessionId) || `Session ${sessionId.slice(0, 8)}`;

/** The calling chat, by its canonical id, with the project it works in; never a design session. */
export function resolveCaller(env: CollabEnv, tokenSessionId: string): Resolved<CollabCaller> {
  const sessionId = env.canonical(tokenSessionId);
  if (env.isDesignSession(sessionId)) return { ok: false, refusal: "design_session", message: "A design session cannot use the session tools." };
  const live = env.live(sessionId);
  const projectPath = live?.projectPath ?? env.storedProjectPath(sessionId);
  const providerId = live?.providerId ?? env.storedProvider(sessionId);
  if (!projectPath || !isProvider(providerId)) return { ok: false, refusal: "not_found", message: "This chat has no project, so it cannot open or message sessions." };
  const projectName = live?.projectName ?? env.projectNameOf(projectPath);
  if (!projectName) return { ok: false, refusal: "not_found", message: "This chat's project is not registered in PPM." };
  return { ok: true, value: { sessionId, providerId, projectName, projectPath, title: titleOf(env, sessionId) } };
}

/**
 * The session `rawId` names, proven to be in the caller's project from what PPM already knows —
 * the chat registry, then its database. A session PPM has no record of is not found, even with a
 * transcript in the project's folder: it may be open in the user's own terminal, where a second
 * process resuming it would write into the same transcript. Nothing here scans a provider's files.
 */
export function resolveTarget(env: CollabEnv, caller: CollabCaller, rawId: unknown): Resolved<CollabTarget> {
  if (typeof rawId !== "string" || !SESSION_ID_RE.test(rawId)) return { ok: false, refusal: "invalid", message: "`session_id` is not a session id." };
  const sessionId = env.canonical(rawId);
  if (sessionId === caller.sessionId) return { ok: false, refusal: "self", message: "That is your own session; a session cannot message itself." };
  if (env.isDesignSession(sessionId)) return { ok: false, refusal: "design_session", message: "That is a design session, which does not take messages from other sessions." };
  const live = env.live(sessionId);
  const projectPath = live?.projectPath ?? env.storedProjectPath(sessionId);
  const providerId = live?.providerId ?? env.storedProvider(sessionId);
  if (!projectPath) {
    return {
      ok: false, refusal: "not_found",
      message: "No PPM session with that id is known in this project. Sessions PPM did not open (one running in a terminal, say) cannot be messaged.",
    };
  }
  if (!samePath(projectPath, caller.projectPath)) {
    return { ok: false, refusal: "other_project", message: "That session belongs to another project; the session tools reach your own project only." };
  }
  if (!isProvider(providerId)) return { ok: false, refusal: "not_found", message: "That session runs on a provider the session tools do not reach." };
  return { ok: true, value: { sessionId, providerId, title: titleOf(env, sessionId) } };
}

/**
 * What a provider runs when neither the chat nor the config names a mode: `claude-agent-sdk.ts`
 * falls back to bypass, and so does `permissionModeToCodex`. A Claude chat never given a mode is
 * therefore a bypass chat, not one whose mode cannot be told.
 */
const PROVIDER_FALLBACK_MODE: Record<string, string> = { claude: "bypassPermissions", codex: "bypassPermissions" };

/** The mode a session runs under: the one chosen for it, else its provider's configured default, else what the provider falls back to; null if none. */
export function effectivePermissionMode(env: CollabEnv, sessionId: string, providerId: string): string | null {
  return env.live(sessionId)?.permissionMode || env.storedPermissionMode(sessionId) || env.providerDefaultPermissionMode(providerId)
    || PROVIDER_FALLBACK_MODE[providerId] || null;
}

/** First line of text the user reads on a card: one line, at most `max` characters. */
export function preview(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A title as PPM sets it: one line, at most `max` characters, never empty. */
export function sanitizeTitle(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const flat = Array.from(raw.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim()).slice(0, max).join("").trim();
  return flat || null;
}

export const toEpochIso = (ms: number | undefined): string | null => (ms ? new Date(ms).toISOString() : null);
