/**
 * The real `TaskLinkStateSource`: Jira and PR states from the `task_link_state` cache, session
 * states live from the chat layer. A read never waits on the network: it answers from the cache at
 * once and queues the links whose state is missing or older than two minutes; the queue reads them
 * in batches, at most four requests at a time, and pushes a `link_states` event for every project
 * whose cached states moved. A background pass every 15 minutes refreshes the Jira and PR links of
 * open tasks in switched-on projects. Nothing here writes a task: what changed outside is news for
 * the manager to act on.
 */
import { createLogger } from "../../logger.ts";
import { getDb } from "../../db.service.ts";
import type { LinkKind, LinkState } from "../../../shared/ppm-tasks.ts";
import type { TaskLinkStateSource } from "../ppm-tasks-link-state-source.ts";
import { ppmTasksEvents } from "../ppm-tasks-events.ts";
import { readJiraStates, JIRA_BATCH } from "./jira-link-state-reader.ts";
import { PR_BATCH, readPrStates, type ReadResult } from "./github-pr-link-state-reader.ts";
import { readSessionState } from "./session-link-state-reader.ts";

const log = createLogger("ppm-tasks");

export const LINK_STATE_TTL_MS = 2 * 60_000;
export const LINK_REFRESH_EVERY_MS = 15 * 60_000;
export const LINK_READ_CONCURRENCY = 4;

type Remote = Extract<LinkKind, "jira" | "pr">;
const isRemote = (kind: LinkKind): kind is Remote => kind === "jira" || kind === "pr";

export interface LinkStateEnv {
  now(): number;
  /** Null: the site asked to back off and nothing was read. */
  readJira(projectKey: string, refs: string[]): Promise<Map<string, ReadResult> | null>;
  readPrs(refs: string[]): Promise<Map<string, ReadResult>>;
  emit(projectKeys: string[]): void;
}

export const liveLinkStateEnv: LinkStateEnv = {
  now: () => Date.now(),
  readJira: (projectKey, refs) => readJiraStates(projectKey, refs),
  readPrs: (refs) => readPrStates(refs),
  emit: (projectKeys) => ppmTasksEvents.emit({ type: "link_states", projectKeys }),
};

/** JSON with keys in a fixed order, so the same state always reads as the same text. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * What counts as a change: everything but a Jira issue's `updated`, which moves on every comment
 * and watcher and would make each of those news for the manager.
 */
export function comparable(kind: LinkKind, stateJson: string | null): string | null {
  if (!stateJson) return null;
  if (kind !== "jira") return stateJson;
  try {
    const { updated: _ignored, ...rest } = JSON.parse(stateJson) as Record<string, unknown>;
    return stableJson(rest);
  } catch {
    return stateJson;
  }
}

interface CacheRow { kind: LinkKind; ref: string; project_key: string; state_json: string | null; error: string | null; checked_at: number | null; changed_at: number | null }

function parseState(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const groupKey = (projectKey: string, kind: Remote) => `${kind}\u0000${projectKey}`;

export function createLinkStateService(env: LinkStateEnv = liveLinkStateEnv) {
  /** Refs waiting to be read, per project and kind. */
  const queued = new Map<string, { projectKey: string; kind: Remote; refs: Set<string> }>();
  const inFlight = new Set<string>();
  /** Project and kind groups a site asked us to leave alone, until when. */
  const held = new Map<string, number>();
  let active = 0;
  let idleWaiters: Array<() => void> = [];
  let timer: ReturnType<typeof setInterval> | null = null;

  function cached(projectKey: string): Map<string, CacheRow> {
    const rows = getDb().query("SELECT * FROM task_link_state WHERE project_key = ?").all(projectKey) as CacheRow[];
    return new Map<string, CacheRow>(rows.map((r) => [`${r.kind}\u0000${r.ref}`, r]));
  }

  /** Stores what was read; returns whether anything a reader sees moved. */
  function store(projectKey: string, kind: Remote, ref: string, result: ReadResult, at: number): boolean {
    const db = getDb();
    const before = db.query("SELECT * FROM task_link_state WHERE kind = ? AND ref = ? AND project_key = ?").get(kind, ref, projectKey) as CacheRow | null;
    // A failed read keeps the last good state beside its error: a timeout is not a change.
    const stateJson = result.state ? stableJson(result.state) : before?.state_json ?? null;
    // A first good read is not a change, even after failed ones: the manager is told about moves,
    // not about links it just added.
    const changed = !!before?.state_json && !!result.state && comparable(kind, before.state_json) !== comparable(kind, stateJson);
    const changedAt = changed ? at : before?.changed_at ?? null;
    db.query(
      `INSERT INTO task_link_state (kind, ref, project_key, state_json, error, checked_at, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, ref, project_key) DO UPDATE SET state_json = excluded.state_json, error = excluded.error,
         checked_at = excluded.checked_at, changed_at = excluded.changed_at`,
    ).run(kind, ref, projectKey, stateJson, result.error, at, changedAt);
    return !before || before.state_json !== stateJson || before.error !== result.error;
  }

  async function runGroup(projectKey: string, kind: Remote, refs: string[]): Promise<boolean> {
    const results = kind === "jira" ? await env.readJira(projectKey, refs) : await env.readPrs(refs);
    if (!results) {
      // The site paused us: leave this project's links alone for a TTL instead of asking (and
      // decrypting its credentials) again on every read.
      held.set(groupKey(projectKey, kind), env.now() + LINK_STATE_TTL_MS);
      return false;
    }
    const at = env.now();
    let moved = false;
    for (const [ref, result] of results) moved = store(projectKey, kind, ref, result, at) || moved;
    return moved;
  }

  function settle(): void {
    if (active === 0 && queued.size === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  function pump(): void {
    while (active < LINK_READ_CONCURRENCY && queued.size > 0) {
      const [key, group] = queued.entries().next().value!;
      const batch = [...group.refs].slice(0, group.kind === "jira" ? JIRA_BATCH : PR_BATCH);
      for (const ref of batch) group.refs.delete(ref);
      if (group.refs.size === 0) queued.delete(key);
      const ids = batch.map((ref) => `${key}\u0000${ref}`);
      for (const id of ids) inFlight.add(id);
      active++;
      runGroup(group.projectKey, group.kind, batch)
        .then((moved) => { if (moved) env.emit([group.projectKey]); })
        .catch((e) => log.warn(`link state read failed (${group.kind}): ${(e as Error).message}`))
        .finally(() => {
          for (const id of ids) inFlight.delete(id);
          active--;
          pump();
          settle();
        });
    }
  }

  function enqueue(projectKey: string, kind: Remote, ref: string): void {
    const key = groupKey(projectKey, kind);
    if (inFlight.has(`${key}\u0000${ref}`) || (held.get(key) ?? 0) > env.now()) return;
    const group = queued.get(key) ?? { projectKey, kind, refs: new Set<string>() };
    group.refs.add(ref);
    queued.set(key, group);
  }

  const source: TaskLinkStateSource = {
    states(projectKey, links) {
      const now = env.now();
      const rows = links.some((l) => isRemote(l.kind)) ? cached(projectKey) : new Map<string, CacheRow>();
      let queuedAny = false;
      const out = links.map((link): LinkState => {
        if (link.kind === "session") {
          return { kind: link.kind, ref: link.ref, state: readSessionState(link.ref) as unknown as Record<string, unknown>, error: null, checkedAt: now, changedAt: null };
        }
        if (!isRemote(link.kind)) return { kind: link.kind, ref: link.ref, state: null, error: null, checkedAt: null, changedAt: null };
        const row = rows.get(`${link.kind}\u0000${link.ref}`);
        if (!row || row.checked_at === null || now - row.checked_at >= LINK_STATE_TTL_MS) {
          enqueue(projectKey, link.kind, link.ref);
          queuedAny = true;
        }
        return row
          ? { kind: link.kind, ref: link.ref, state: parseState(row.state_json), error: row.error, checkedAt: row.checked_at, changedAt: row.changed_at }
          : { kind: link.kind, ref: link.ref, state: null, error: null, checkedAt: null, changedAt: null };
      });
      if (queuedAny) pump();
      return out;
    },
    sessionState: (sessionId, task) => readSessionState(sessionId, task),
  };

  /** Queues every Jira and PR link of open tasks in switched-on projects; returns how many. */
  function refreshAll(): number {
    const rows = getDb().query(
      `SELECT DISTINCT l.kind AS kind, l.ref AS ref, t.project_key AS project_key FROM task_links l
       JOIN tasks t ON t.id = l.task_id
       JOIN task_projects p ON p.project_key = t.project_key AND p.enabled = 1
       LEFT JOIN task_statuses s ON s.id = t.status_id
       WHERE t.deleted_at IS NULL AND (s.base_group IS NULL OR s.base_group <> 'closed') AND l.kind IN ('jira', 'pr')`,
    ).all() as Array<{ kind: Remote; ref: string; project_key: string }>;
    for (const r of rows) enqueue(r.project_key, r.kind, r.ref);
    if (rows.length) pump();
    return rows.length;
  }

  return {
    source,
    refreshAll,
    /** Resolves once nothing is queued or being read (tests, shutdown). */
    idle(): Promise<void> {
      if (active === 0 && queued.size === 0) return Promise.resolve();
      return new Promise((resolve) => { idleWaiters.push(resolve); });
    },
    start(): void {
      if (timer) return;
      const refresh = () => {
        try { refreshAll(); } catch (e) { log.warn(`link state refresh failed: ${(e as Error).message}`); }
      };
      // Once a minute after start (off the boot path), then every 15 minutes.
      setTimeout(refresh, 60_000).unref?.();
      timer = setInterval(refresh, LINK_REFRESH_EVERY_MS);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** In-flight reads right now (tests check the cap). */
    activeReads: () => active,
  };
}

export type LinkStateService = ReturnType<typeof createLinkStateService>;
