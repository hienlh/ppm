/**
 * Manager rules as the rest of PPM uses them: the entry a manager chat's turn carries, and what
 * the user does with the rules (read them, write their own, approve or revert a held change).
 * Every write goes through the guard's per-project queue, so it never interleaves with a check.
 */
import { createLogger } from "../logger.ts";
import { RULES_FILE_MAX_BYTES } from "../../shared/assistant-limits.ts";
import { managerChats, ManagerChatError } from "./manager-chats.service.ts";
import { managerContextEntry } from "./manager-context-entry.ts";
import { managerRulesTemplate } from "./manager-rules-default-template.ts";
import { linesAddedSince, linesRemovedSince } from "./manager-rules-diff.ts";
import { rulesFileTracked } from "./manager-rules-file.ts";
import { approveHeldManagerRules, clearHeldManagerRules, getManagerRules, setManagerRulesByUser, type ManagerRules } from "./manager-rules-db.ts";
import { managerRulesGuard, UNTRACK_MESSAGE, type ManagerRulesGuard, type RulesTarget } from "./manager-rules-guard.ts";
import { managerRulesEvents } from "./manager-rules-events.ts";

const log = createLogger("manager-rules");

/** What `GET /api/assistant/managers/:project/rules` answers. */
export interface ManagerRulesView extends ManagerRules {
  /** Lines in force that the user has not approved yet, in order. */
  addedSince: string[];
  /** The held change against the rules in force, when one waits: what it adds and removes. */
  proposedDiff: { added: string[]; removed: string[] } | null;
}

function targetFor(projectName: string): RulesTarget {
  const project = managerChats.project(projectName, true);
  const row = managerChats.managerFor(project.path);
  if (!row) throw new ManagerChatError("That project has no manager chat", 404);
  return { projectKey: row.projectKey, projectPath: row.projectPath, projectName: project.name, sessionId: row.sessionId };
}

/**
 * The shared-context entry for a manager chat's turn, after the file was checked; undefined for
 * any other chat. A failed check never fails the turn: the stored rules are sent as they are.
 */
export async function managerRulesEntryFor(sessionId: string, guard: ManagerRulesGuard = managerRulesGuard): Promise<string | undefined> {
  const row = managerChats.forSession(sessionId);
  if (!row) return undefined;
  const target: RulesTarget = { projectKey: row.projectKey, projectPath: row.projectPath, projectName: row.projectName, sessionId: row.sessionId };
  let rules: ManagerRules | null;
  try {
    rules = await guard.check(target);
  } catch (e) {
    log.warn(`project=${row.projectName} rules check failed: ${(e as Error).message}`);
    rules = getManagerRules(row.projectKey);
  }
  const approved = rules?.approved ?? managerRulesTemplate();
  return managerContextEntry(row.projectName, approved, rules?.accepted ?? approved);
}

export function managerRulesView(projectName: string): ManagerRulesView {
  const rules = getManagerRules(targetFor(projectName).projectKey);
  if (!rules) throw new ManagerChatError("That project has no manager chat", 404);
  const base = rules.accepted ?? rules.approved ?? "";
  return {
    ...rules,
    addedSince: rules.approved !== null && rules.accepted !== null ? linesAddedSince(rules.approved, rules.accepted) : [],
    proposedDiff: rules.proposed !== null
      ? { added: linesAddedSince(base, rules.proposed), removed: linesRemovedSince(base, rules.proposed) }
      : null,
  };
}

/**
 * The user's own rules: written to the file and in force at once, with no decision to make. The
 * change is always announced with its diff, so a write the user did not make is seen.
 */
export async function setManagerRulesText(projectName: string, text: string, fetchSite: string | null, guard: ManagerRulesGuard = managerRulesGuard): Promise<void> {
  if (Buffer.byteLength(text) > RULES_FILE_MAX_BYTES) throw new ManagerChatError(`Rules must be at most ${RULES_FILE_MAX_BYTES / 1024} KB`);
  const target = targetFor(projectName);
  await guard.withLock(target.projectKey, async () => {
    await refuseTracked(target);
    const before = getManagerRules(target.projectKey)?.accepted ?? "";
    if (!(await guard.write(target, text))) throw new Error("Could not write .ppm/manager.md");
    setManagerRulesByUser(target.projectKey, text, Date.now());
    managerRulesEvents.emit({
      projectKey: target.projectKey, projectName: target.projectName, sessionId: target.sessionId,
      type: "rules_edited", added: linesAddedSince(before, text), removed: linesRemovedSince(before, text), fetchSite,
    });
  });
  await announce(target.projectName);
}

/** A file git tracks is the repository's: PPM neither reads it as rules nor writes over it. */
async function refuseTracked(target: RulesTarget): Promise<void> {
  if ((await rulesFileTracked(target.projectPath)) !== "untracked") throw new ManagerChatError(UNTRACK_MESSAGE);
}

/** The manager list carries whether a change waits on the user. */
async function announce(projectName: string): Promise<void> {
  managerChats.invalidate();
  const { announceManagersChanged } = await import("./manager-chats-announce.ts");
  await announceManagersChanged([projectName]);
}

/** Approve or revert the held change named by `hash`; a stale hash (another change, or already decided) is refused. */
export async function decideManagerRules(projectName: string, action: "approve" | "revert", hash: string, guard: ManagerRulesGuard = managerRulesGuard): Promise<void> {
  const target = targetFor(projectName);
  await guard.withLock(target.projectKey, async () => {
    const held = getManagerRules(target.projectKey);
    if (!held || held.pendingHash !== hash || held.proposed === null) throw new ManagerChatError("That rules change is no longer waiting");
    if (action === "approve") {
      if (Buffer.byteLength(held.proposed) > RULES_FILE_MAX_BYTES) {
        throw new ManagerChatError(`That change is larger than ${RULES_FILE_MAX_BYTES / 1024} KB; shorten it in Settings instead`);
      }
      await refuseTracked(target);
      const text = approveHeldManagerRules(target.projectKey, hash, Date.now());
      if (text === null) throw new ManagerChatError("That rules change is no longer waiting");
      // Stored either way: the next manager turn writes the rules in force back if this failed.
      if (!(await guard.write(target, text))) log.warn(`project=${target.projectName} approved rules are stored but not on disk yet`);
    } else {
      if (!clearHeldManagerRules(target.projectKey, hash)) throw new ManagerChatError("That rules change is no longer waiting");
      // The hold already put the rules in force back on disk; this covers a write that failed then.
      if (held.accepted !== null && (await rulesFileTracked(target.projectPath)) === "untracked") await guard.write(target, held.accepted);
    }
    managerRulesEvents.emit({ projectKey: target.projectKey, projectName: target.projectName, sessionId: target.sessionId, type: "rules_decided", action, hash });
  });
  await announce(target.projectName);
}
