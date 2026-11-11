/**
 * Keeps a project's `.ppm/manager.md` and the rules its manager chat is told in agreement, on
 * every manager turn start and on first assign.
 *
 * A change the manager makes is accepted on its own only when it is plain inserted lines the
 * one-shot check calls restrictions. Anything else is held: kept off disk as `rules_proposed`
 * (the file goes back to the rules in force) until the user approves or reverts it. A file that
 * already existed when the project got its manager is untrusted (a cloned repository may ship
 * one): the template goes in force and the old text waits for the user like any held change.
 */
import { createHash } from "node:crypto";
import { createLogger } from "../logger.ts";
import { managerChats } from "./manager-chats.service.ts";
import { checkAddedRules, askClaudeForRulesCheck, type RulesCheckAsk } from "./manager-rules-check.ts";
import { addedLinesWithHeading, classifyRulesChange, heldChangeLines } from "./manager-rules-diff.ts";
import { ensureRulesGitignore, readRulesFile, rulesFileTracked, writeRulesFile, type RulesFileUnsafe } from "./manager-rules-file.ts";
import { acceptManagerRules, getManagerRules, holdManagerRules, seedManagerRules, type ManagerRules } from "./manager-rules-db.ts";
import { managerRulesEvents, type ManagerRulesEvent, type RulesHeldReason } from "./manager-rules-events.ts";
import { managerRulesTemplate } from "./manager-rules-default-template.ts";
import { RULES_CHECK_TIMEOUT_MS } from "../../shared/assistant-limits.ts";

const log = createLogger("manager-rules");

export interface RulesTarget {
  projectKey: string;
  projectPath: string;
  projectName: string;
  sessionId: string;
}

export interface RulesGuardEnv {
  ask: RulesCheckAsk;
  checkTimeoutMs: number;
  now(): number;
  tracked(projectPath: string): Promise<"tracked" | "untracked" | "unknown">;
  template(): string;
  emit(event: ManagerRulesEvent): void;
  /** Whether a change is waiting on the user changed for this project. */
  pendingChanged(projectName: string): void;
}

export const UNTRACK_MESSAGE = "Untrack .ppm/manager.md (git rm --cached) to use it as manager rules";

const UNREADABLE: Record<RulesFileUnsafe | "unknown_tracked" | "too_large", string> = {
  symlink: ".ppm/manager.md was a link; PPM put the rules in force in its place (what it pointed to is untouched)",
  hardlink: ".ppm/manager.md shared its contents with another file; PPM put the rules in force in its place",
  not_a_file: ".ppm/manager.md is not a file; the stored rules stay in force",
  dir_unsafe: ".ppm is not a plain folder; the stored rules stay in force",
  unknown_tracked: "PPM could not ask git whether .ppm/manager.md is tracked; the stored rules stay in force",
  too_large: ".ppm/manager.md grew too large to keep for review; PPM put the rules in force back",
};

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const realEnv: RulesGuardEnv = {
  ask: askClaudeForRulesCheck,
  checkTimeoutMs: RULES_CHECK_TIMEOUT_MS,
  now: () => Date.now(),
  tracked: (projectPath) => rulesFileTracked(projectPath),
  template: managerRulesTemplate,
  emit: (event) => managerRulesEvents.emit(event),
  pendingChanged: (projectName) => {
    managerChats.invalidate();
    // Loaded on use: the announcement reaches the chat registry, which loads after this module.
    void import("./manager-chats-announce.ts")
      .then(({ announceManagersChanged }) => announceManagersChanged([projectName]))
      .catch((e) => log.warn(`Could not announce a rules change: ${(e as Error).message}`));
  },
};

export function createManagerRulesGuard(overrides: Partial<RulesGuardEnv> = {}) {
  const env: RulesGuardEnv = { ...realEnv, ...overrides };
  const queues = new Map<string, Promise<unknown>>();
  /** The unreadable reason last told per project, so a broken file is said once, not every turn. */
  const said = new Map<string, string>();

  /** One rules operation per project at a time: a turn start, an assign, a decision. */
  function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const run = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    queues.set(key, run);
    void run.finally(() => { if (queues.get(key) === run) queues.delete(key); }).catch(() => {});
    return run;
  }

  const base = (t: RulesTarget) => ({ projectKey: t.projectKey, projectName: t.projectName, sessionId: t.sessionId });

  function unreadable(t: RulesTarget, reason: string, message: string): void {
    if (said.get(t.projectKey) === reason) return;
    said.set(t.projectKey, reason);
    env.emit({ ...base(t), type: "rules_unreadable", reason, message });
  }

  async function write(t: RulesTarget, text: string): Promise<boolean> {
    try {
      await writeRulesFile(t.projectPath, text);
      return true;
    } catch (e) {
      log.warn(`project=${t.projectName} could not write .ppm/manager.md: ${(e as Error).message}`);
      return false;
    }
  }

  async function hold(t: RulesTarget, rules: ManagerRules, text: string, hash: string, reason: RulesHeldReason, lines: string[], detail?: string) {
    holdManagerRules(t.projectKey, text, hash);
    await write(t, rules.accepted ?? "");
    // The card shows the whole change, the way Settings does, never only the lines that held it.
    const diff = reason === "too_large" ? null : heldChangeLines(rules.accepted ?? rules.approved ?? "", text);
    env.emit({ ...base(t), type: "rules_loosen_pending", hash, reason, lines, diff, ...(detail ? { detail } : {}) });
    env.pendingChanged(t.projectName);
  }

  /** First rules for a project that has none: the template in force, an existing file held for the user. */
  async function seed(t: RulesTarget): Promise<void> {
    const rules = getManagerRules(t.projectKey);
    if (!rules || rules.approved !== null) return;
    const template = env.template();
    const read = await readRulesFile(t.projectPath);
    let writeTemplate = read.kind === "missing";
    let held: { text: string; hash: string } | null = null;
    if (read.kind === "unsafe") {
      writeTemplate = read.replaceable;
      unreadable(t, read.reason, UNREADABLE[read.reason]);
    } else if (read.kind === "file" || read.kind === "too_large") {
      const tracked = await env.tracked(t.projectPath);
      if (tracked !== "untracked") unreadable(t, "tracked", tracked === "tracked" ? UNTRACK_MESSAGE : UNREADABLE.unknown_tracked);
      else if (read.text === null) unreadable(t, "too_large", UNREADABLE.too_large);
      else if (read.kind === "too_large" || classifyRulesChange(template, read.text).kind !== "same") {
        held = { text: read.text, hash: sha256(read.text) };
        writeTemplate = true;
      }
    }
    if (!seedManagerRules(t.projectKey, template, held, env.now())) return;
    if (writeTemplate) await write(t, template);
    else if (read.kind !== "unsafe" || read.reason !== "dir_unsafe") await ensureRulesGitignore(t.projectPath).catch(() => {});
    if (held) {
      // Against the template now in force, as Settings shows it; a file with no rule line has
      // nothing to read on a card, so it is decided in Settings only.
      const diff = read.kind === "too_large" ? null : heldChangeLines(template, held.text);
      env.emit({ ...base(t), type: "rules_loosen_pending", hash: held.hash, reason: "existing_file", lines: [], diff });
      env.pendingChanged(t.projectName);
    }
  }

  /** The turn-start check: the file judged against the rules in force. Answers the rules in force. */
  async function check(t: RulesTarget): Promise<ManagerRules | null> {
    let rules = getManagerRules(t.projectKey);
    if (!rules) return null;
    if (rules.approved === null || rules.accepted === null) {
      await seed(t);
      rules = getManagerRules(t.projectKey);
      if (!rules || rules.accepted === null) return rules;
    }
    const accepted = rules.accepted!;
    const read = await readRulesFile(t.projectPath);
    if (read.kind === "missing") {
      if (await write(t, accepted)) env.emit({ ...base(t), type: "rules_restored" });
      said.delete(t.projectKey);
      return rules;
    }
    if (read.kind === "unsafe") {
      if (read.replaceable) await write(t, accepted);
      unreadable(t, read.reason, UNREADABLE[read.reason]);
      return rules;
    }
    const change = read.kind === "file" ? classifyRulesChange(accepted, read.text) : null;
    if (change?.kind === "same") {
      said.delete(t.projectKey);
      return rules;
    }
    const tracked = await env.tracked(t.projectPath);
    if (tracked !== "untracked") {
      unreadable(t, "tracked", tracked === "tracked" ? UNTRACK_MESSAGE : UNREADABLE.unknown_tracked);
      return rules;
    }
    said.delete(t.projectKey);
    if (read.text === null) {
      await write(t, accepted);
      unreadable(t, "too_large", UNREADABLE.too_large);
      return rules;
    }
    const hash = sha256(read.text);
    // The change already waiting on the user, written again: back off disk, said once already.
    if (hash === rules.pendingHash) {
      await write(t, accepted);
      return rules;
    }
    if (!change) await hold(t, rules, read.text, hash, "too_large", []);
    else if (change.kind === "hold") await hold(t, rules, read.text, hash, change.reason, change.lines);
    else {
      // Each line with the heading it lands under: where it sits decides what it means.
      const verdict = await checkAddedRules(rules.approved ?? "", addedLinesWithHeading(accepted, read.text!), env.ask, env.checkTimeoutMs);
      if (verdict.ok) {
        acceptManagerRules(t.projectKey, read.text);
        env.emit({ ...base(t), type: "rules_tightened", lines: change.lines });
      } else if (verdict.reason === "relaxes_or_unclear") await hold(t, rules, read.text, hash, verdict.reason, verdict.lines);
      else await hold(t, rules, read.text, hash, verdict.reason, change.lines, verdict.detail);
    }
    return getManagerRules(t.projectKey);
  }

  return {
    seed: (t: RulesTarget) => serialize(t.projectKey, () => seed(t)),
    check: (t: RulesTarget) => serialize(t.projectKey, () => check(t)),
    /** Runs `work` in the project's rules queue, so a decision never interleaves with a check. */
    withLock: <T>(projectKey: string, work: () => Promise<T>) => serialize(projectKey, work),
    write,
  };
}

export type ManagerRulesGuard = ReturnType<typeof createManagerRulesGuard>;

export const managerRulesGuard = createManagerRulesGuard();
