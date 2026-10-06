/**
 * The Issues tab: the last day's errors and warnings, grouped by cause and labelled by AI as a
 * likely PPM bug, a setup problem, an upstream tool's problem, or expected noise.
 *
 * Grouping happens twice. First by fingerprint (`log-fingerprint.ts`): copies of one event
 * become one pattern, so 48 copies of a warning cost one line of prompt. Then the AI puts
 * patterns that share a cause into one issue — a restart that cut off the tunnel and the
 * browsers is one issue, not three. What it said is kept per fingerprint in
 * `<ppm dir>/logs-issues.json`, so a later run only sends patterns no issue covers yet, and
 * counts stay current without any AI at all: they are recomputed from the logs on every read.
 *
 * "Auto" runs at most every ten minutes, and only when something is reading the issues (the
 * Logs window, or the rail button's badge) and there is a pattern no run has seen. A pattern
 * the AI left out is not sent again by Auto; Re-analyze sends everything in the window.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { platform, release } from "node:os";
import { getPpmDir } from "../ppm-dir.ts";
import { createLogger } from "../logger.ts";
import { VERSION } from "../../version.ts";
import { logFingerprint } from "../../shared/log-fingerprint.ts";
import { levelBucket, logSourceLabel, type LogEntry, type LogSourceId } from "../../shared/logs-model.ts";
import { DEFAULT_REDACT, redactLogText } from "../../shared/log-redact.ts";
import { ISSUE_CLASSES, type IssueClass, type LogIssue, type LogIssuesResult, type LogIssuesSummary } from "../../shared/logs-api.ts";
import { askClaude, clip, extractJson, LOGS_AI_MODEL_NAME, type AskFn } from "./log-ai.ts";
import { readProblems, restartTimes } from "./log-store.ts";

const log = createLogger("logs");

export const ISSUE_WINDOW_MS = 24 * 60 * 60 * 1000;
const AUTO_EVERY_MS = 10 * 60 * 1000;
const MAX_PATTERNS_PER_RUN = 60;
const KEEP_ISSUES_MS = 14 * 24 * 60 * 60 * 1000;
const VIEW_CACHE_MS = 15_000;
const LINES_PER_ISSUE = 20;

interface StoredIssue {
  id: string;
  cls: IssueClass;
  title: string;
  area: string;
  why: string;
  fix?: string;
  fingerprints: string[];
  createdAt: number;
  lastSeen: number;
}

interface IssuesState {
  version: 1;
  auto: boolean;
  issues: StoredIssue[];
  /** Fingerprint → when it was dismissed. An issue is hidden when all of its patterns are. */
  dismissed: Record<string, number>;
  /** Patterns a run was given and put in no issue; Auto does not send them again. */
  skipped: Record<string, number>;
  analyzedAt: number | null;
  attemptedAt: number | null;
  lastRun: { lines: number; patterns: number; tokens: number } | null;
  error: string | null;
}

interface Group {
  fp: string;
  src: LogSourceId;
  tag: string;
  lv: "error" | "warn";
  entries: LogEntry[];
}

const CLASS_ORDER: Readonly<Record<IssueClass, number>> = { bug: 0, setup: 1, upstream: 2, expected: 3 };

function defaultState(): IssuesState {
  return { version: 1, auto: true, issues: [], dismissed: {}, skipped: {}, analyzedAt: null, attemptedAt: null, lastRun: null, error: null };
}

function statePath(): string {
  return join(getPpmDir(), "logs-issues.json");
}

let state: IssuesState | null = null;
let running: Promise<void> | null = null;
let viewCache: { at: number; view: View } | null = null;
const listeners = new Set<() => void>();
let ask: AskFn = askClaude;

function load(): IssuesState {
  if (state) return state;
  try {
    if (existsSync(statePath())) {
      const raw = JSON.parse(readFileSync(statePath(), "utf8")) as Partial<IssuesState>;
      if (raw && raw.version === 1) state = { ...defaultState(), ...raw, issues: Array.isArray(raw.issues) ? raw.issues : [] };
    }
  } catch (e) {
    log.warn(`issue state unreadable, starting over: ${(e as Error).message}`);
  }
  return (state ??= defaultState());
}

function save(): void {
  const s = load();
  const now = Date.now();
  s.issues = s.issues.filter((i) => now - i.lastSeen < KEEP_ISSUES_MS);
  for (const [fp, at] of Object.entries(s.dismissed)) if (now - at > 2 * KEEP_ISSUES_MS) delete s.dismissed[fp];
  for (const [fp, at] of Object.entries(s.skipped)) if (now - at > KEEP_ISSUES_MS) delete s.skipped[fp];
  const tmp = `${statePath()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    renameSync(tmp, statePath());
  } catch (e) {
    log.warn(`issue state not saved: ${(e as Error).message}`);
  }
}

function changed(): void {
  viewCache = null;
  for (const cb of listeners) {
    try { cb(); } catch { /* a listener must not break the caller */ }
  }
}

/** Called when the issues or their state change, so `/ws/global` can tell open windows. */
export function onIssuesChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function groupProblems(entries: readonly LogEntry[]): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const e of entries) {
    const b = levelBucket(e.lv);
    if (b !== "error" && b !== "warn") continue;
    const fp = logFingerprint(e);
    const g = groups.get(fp);
    if (g) g.entries.push(e);
    else groups.set(fp, { fp, src: e.src, tag: e.tag, lv: b, entries: [e] });
  }
  return groups;
}

interface View {
  result: LogIssuesResult;
  groups: Map<string, Group>;
  /** Patterns no issue covers and no run has skipped: what Auto would send. */
  pending: number;
}

function mostCommonSource(entries: readonly LogEntry[]): LogSourceId {
  const n = new Map<LogSourceId, number>();
  for (const e of entries) n.set(e.src, (n.get(e.src) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "server";
}

async function computeView(force = false): Promise<View> {
  if (!force && viewCache && Date.now() - viewCache.at < VIEW_CACHE_MS) return viewCache.view;
  const s = load();
  const windowFrom = Date.now() - ISSUE_WINDOW_MS;
  const groups = groupProblems(await readProblems(windowFrom));
  const covered = new Set<string>();
  const issues: LogIssue[] = [];
  for (const si of s.issues) {
    const gs = si.fingerprints.map((fp) => groups.get(fp)).filter((g): g is Group => !!g);
    for (const fp of si.fingerprints) covered.add(fp);
    if (!gs.length) continue;
    const all = gs.flatMap((g) => g.entries).sort((a, b) => a.ts - b.ts);
    const last = all[all.length - 1]!.ts;
    si.lastSeen = Math.max(si.lastSeen, last);
    issues.push({
      id: si.id,
      cls: si.cls,
      title: si.title,
      area: si.area,
      src: mostCommonSource(all),
      why: si.why,
      ...(si.fix ? { fix: si.fix } : {}),
      count: all.length,
      errors: all.filter((e) => levelBucket(e.lv) === "error").length,
      warnings: all.filter((e) => e.lv === "warn").length,
      last,
      lines: all.slice(-LINES_PER_ISSUE),
      dismissed: gs.every((g) => s.dismissed[g.fp] !== undefined),
    });
  }
  issues.sort((a, b) => CLASS_ORDER[a.cls] - CLASS_ORDER[b.cls] || b.last - a.last);
  let unsorted = 0;
  let pending = 0;
  for (const g of groups.values()) {
    if (covered.has(g.fp)) continue;
    unsorted += g.entries.length;
    if (s.skipped[g.fp] === undefined) pending++;
  }
  const view: View = {
    groups,
    pending,
    result: {
      issues,
      unsorted,
      analyzedAt: s.analyzedAt,
      model: LOGS_AI_MODEL_NAME,
      lastRun: s.lastRun,
      running: running !== null,
      auto: s.auto,
      error: s.error,
      windowFrom,
    },
  };
  viewCache = { at: Date.now(), view };
  return view;
}

function maybeAuto(view: View): void {
  const s = load();
  if (!s.auto || running || view.pending === 0) return;
  if (s.attemptedAt && Date.now() - s.attemptedAt < AUTO_EVERY_MS) return;
  void analyze(false).catch(() => { /* recorded in state.error */ });
}

export async function getIssues(): Promise<LogIssuesResult> {
  const view = await computeView();
  maybeAuto(view);
  return { ...view.result, running: running !== null };
}

export async function getIssuesSummary(): Promise<LogIssuesSummary> {
  const view = await computeView();
  maybeAuto(view);
  return { likelyBugs: view.result.issues.filter((i) => i.cls === "bug" && !i.dismissed).length, running: running !== null };
}

const SYSTEM_PROMPT = `You sort the errors and warnings in the logs of PPM, a self-hosted web IDE (a Bun server and a React web app) that runs Claude Code and Codex chats, terminals, a file explorer, git tools, remote desktop and tunnels on the user's own machine. The lines come from ppm.log (the server, tagged by subsystem), cloudflared.log (the tunnel) and the browser consoles of open PPM tabs.

Put patterns that share one cause into one issue: a restart that makes the tunnel and the browsers lose the server for a few seconds is one issue, not three. Classify each issue:
- "bug": most likely a defect in PPM itself that its author should fix.
- "setup": caused by the user's machine, configuration, permissions, accounts or network; the user can fix it.
- "upstream": a problem in a tool PPM runs or talks to (Claude Code / the Claude Agent SDK, the Codex CLI, cloudflared, git, a language server, the browser) that PPM only passes through.
- "expected": normal operation that happens to be logged as a warning or error: a restart, a client that went away, a retry that worked.

Write for the person running PPM, in plain English: "title" at most 80 characters; "why" at most two sentences that name the evidence; "fix" at most two sentences, only for setup or upstream issues and only when there is something concrete to do; "area" one to three words naming the part of PPM ("Accounts", "Tunnel", "Codex CLI").

Answer with JSON only:
{"issues":[{"patterns":["P1","P4"],"cls":"bug","title":"…","area":"…","why":"…","fix":"…"}],"attach":[{"pattern":"P7","issue":"<id of a known issue>"}]}
Put every pattern either in exactly one new issue or attach it to a known issue with the same cause.`;

const hhmmss = (ts: number) => new Date(ts).toISOString().slice(11, 19);

function patternText(n: number, g: Group): string {
  const e = g.entries[g.entries.length - 1]!;
  const r = (t: string) => redactLogText(t, DEFAULT_REDACT);
  const head = `P${n} · ${logSourceLabel(g.src)} · ${g.tag} · ${g.lv.toUpperCase()} · ${g.entries.length}× · last ${hhmmss(e.ts)}`;
  const more = (e.more ?? []).filter((l) => l.trim()).slice(0, 4).map((l) => `    ${clip(r(l), 160)}`);
  return [head, `  ${clip(r(e.msg), 400)}`, ...more].join("\n");
}

function isClass(v: unknown): v is IssueClass {
  return typeof v === "string" && (ISSUE_CLASSES as readonly string[]).includes(v);
}

/**
 * Send the patterns no issue covers to the AI and keep what it says. `full` re-sorts every
 * pattern in the window from scratch (Re-analyze); issues outside the window are kept.
 */
export function analyze(full: boolean): Promise<void> {
  if (running) return running;
  const run = (async () => {
    const s = load();
    s.attemptedAt = Date.now();
    save();
    changed();
    try {
      const view = await computeView(true);
      const covered = new Set(full ? [] : s.issues.flatMap((i) => i.fingerprints));
      const fresh = [...view.groups.values()]
        .filter((g) => !covered.has(g.fp) && (full || s.skipped[g.fp] === undefined))
        .sort((a, b) => (a.lv === b.lv ? 0 : a.lv === "error" ? -1 : 1) || b.entries.length - a.entries.length)
        .slice(0, MAX_PATTERNS_PER_RUN);
      if (fresh.length === 0) {
        s.analyzedAt = Date.now();
        s.error = null;
        return;
      }
      const known = full ? [] : s.issues.filter((i) => i.fingerprints.some((fp) => view.groups.has(fp)));
      const restarts = await restartTimes(view.result.windowFrom);
      const prompt = [
        `PPM v${VERSION} on ${platform()} ${release()}. Times are UTC; the lines are from the last 24 hours.`,
        restarts.length ? `PPM restarted at ${restarts.map(hhmmss).join(", ")}.` : "PPM did not restart in this window.",
        "",
        known.length ? `Known issues (attach a new pattern to one when it has the same cause):\n${known.map((i) => `- ${i.id} [${i.cls}] ${i.title}`).join("\n")}\n` : "",
        "New patterns:",
        ...fresh.map((g, n) => patternText(n + 1, g)),
      ].join("\n");
      const answer = await ask(SYSTEM_PROMPT, prompt);
      const parsed = extractJson(answer.text) as { issues?: unknown; attach?: unknown };
      const byLabel = new Map(fresh.map((g, n) => [`P${n + 1}`, g]));
      const placed = new Set<string>();
      const created: StoredIssue[] = [];
      const now = Date.now();
      for (const raw of Array.isArray(parsed.issues) ? parsed.issues : []) {
        const r = raw as Record<string, unknown>;
        const groups = (Array.isArray(r.patterns) ? r.patterns : [])
          .map((p) => byLabel.get(String(p)))
          .filter((g): g is Group => !!g && !placed.has(g.fp));
        if (!groups.length || !isClass(r.cls) || !clip(r.title, 100)) continue;
        for (const g of groups) placed.add(g.fp);
        const fix = clip(r.fix, 300);
        created.push({
          id: `i${randomUUID().slice(0, 8)}`,
          cls: r.cls,
          title: clip(r.title, 100),
          area: clip(r.area, 40) || logSourceLabel(groups[0]!.src),
          why: clip(r.why, 400),
          ...(fix && r.cls !== "bug" && r.cls !== "expected" ? { fix } : {}),
          fingerprints: groups.map((g) => g.fp),
          createdAt: now,
          lastSeen: Math.max(...groups.map((g) => g.entries[g.entries.length - 1]!.ts)),
        });
      }
      for (const raw of Array.isArray(parsed.attach) ? parsed.attach : []) {
        const r = raw as Record<string, unknown>;
        const g = byLabel.get(String(r.pattern));
        const target = known.find((i) => i.id === r.issue);
        if (!g || !target || placed.has(g.fp)) continue;
        placed.add(g.fp);
        target.fingerprints.push(g.fp);
      }
      if (full) s.issues = s.issues.filter((i) => !i.fingerprints.some((fp) => view.groups.has(fp)));
      s.issues.push(...created);
      for (const g of fresh) {
        if (placed.has(g.fp)) delete s.skipped[g.fp];
        else s.skipped[g.fp] = now;
      }
      s.analyzedAt = now;
      s.lastRun = { lines: fresh.reduce((a, g) => a + g.entries.length, 0), patterns: fresh.length, tokens: answer.tokens };
      s.error = null;
      log.info(`sorted ${fresh.length} patterns into ${created.length} new issues (${answer.tokens} tokens)`);
    } catch (e) {
      s.error = (e as Error).message;
      log.warn(`issue sorting failed: ${s.error}`);
      throw e;
    } finally {
      save();
    }
  })();
  running = run.finally(() => {
    running = null;
    changed();
  });
  return running;
}

export function setAuto(on: boolean): void {
  const s = load();
  s.auto = on;
  save();
  changed();
}

/** Hide an issue (or bring it back): its patterns are marked, so a re-sort keeps it hidden. */
export async function setDismissed(issueId: string, dismissed: boolean): Promise<boolean> {
  const s = load();
  const issue = s.issues.find((i) => i.id === issueId);
  if (!issue) return false;
  const now = Date.now();
  for (const fp of issue.fingerprints) {
    if (dismissed) s.dismissed[fp] = now;
    else delete s.dismissed[fp];
  }
  save();
  changed();
  return true;
}

export function undismissAll(): void {
  const s = load();
  s.dismissed = {};
  save();
  changed();
}

/** Tests only. */
export function _setIssuesAskForTests(fn: AskFn | null): void {
  ask = fn ?? askClaude;
}

export function _resetIssuesForTests(): void {
  state = null;
  running = null;
  viewCache = null;
}
