import { createLogger } from "../logger.ts";
import type { AssistantBudgetEvent } from "../assistant/assistant-budget-events.ts";
import type { ManagerRulesEvent } from "../assistant-managers/manager-rules-events.ts";
import type { AssistantCards, NewCard } from "./assistant-cards.service.ts";
import type { CardRow } from "./assistant-cards-db.ts";
import { cleanCardBody } from "./card-text-cleaning.ts";

/**
 * Cards for what PPM itself decided about the Assistant and its managers: a change to a project's
 * manager rules (a note, or a held change waiting on the user) and the Assistant pausing its own
 * messages when a budget ran out. Quoted rule lines came from a manager AI or the user's editor:
 * they are shown as text, revealed and neutralized like any report.
 */

export interface EventCardsDeps {
  cards: AssistantCards;
  now(): number;
  /** Open cards of `kind` whose payload `field` is `value`. */
  openBy(kind: "rules_change" | "budget", field: string, value: string): CardRow[];
}

const MAX_LINES = 40;
const BUDGET_TEXT: Record<string, string> = {
  hour: "it used its hourly allowance of messages it sends on its own",
  day: "it used its daily allowance of messages it sends on its own",
  pair: "it sent one manager chat as many messages on its own as allowed",
};
const HELD_TEXT: Record<string, string> = {
  existing_file: "The project already had a rules file; the built-in rules are in force until you choose.",
  removed: "The manager removed or changed lines.",
  structural: "The manager added a heading, comment, quote or markup.",
  keyword: "An added line uses a word that can loosen the rules.",
  too_complex: "The change was too large to compare line by line.",
  too_large: "The file is larger than PPM keeps; it is held whole.",
  relaxes_or_unclear: "The check did not call every added line a restriction.",
  check_failed: "The check could not run, so the change waits for you.",
};

const lines = (list: readonly string[]): string[] => list.slice(0, MAX_LINES).map((l) => cleanCardBody(l, 500));
const log = createLogger("assistant-cards");

export function rulesEventCard(deps: EventCardsDeps, e: ManagerRulesEvent): void {
  const base = { projectName: e.projectName, projectPath: null, projectKey: e.projectKey, sessionId: e.sessionId } as const;
  const create = (input: NewCard) => deps.cards.create(input);
  switch (e.type) {
    case "rules_tightened":
      create({ ...base, kind: "rules_note", title: `The manager added ${e.lines.length} rule line${e.lines.length === 1 ? "" : "s"}`, payload: { added: lines(e.lines) } });
      return;
    case "rules_edited":
      create({
        ...base, kind: "rules_note", title: "The rules were edited in Settings",
        body: e.fetchSite && e.fetchSite !== "same-origin" ? `Sent from a ${cleanCardBody(e.fetchSite, 40)} page.` : "",
        payload: { added: lines(e.added), removed: lines(e.removed) },
      });
      return;
    case "rules_restored":
      create({ ...base, kind: "rules_note", title: "PPM wrote the rules file back", body: "It was missing; the rules in force are unchanged." });
      return;
    case "rules_unreadable":
      create({ ...base, kind: "rules_note", title: "PPM cannot read the rules file", body: cleanCardBody(e.message, 600) });
      return;
    case "rules_loosen_pending": {
      if (deps.openBy("rules_change", "rulesHash", e.hash).length) return;
      const reason = e.reason === "check_failed" && /no claude/i.test(e.detail ?? "")
        ? "The check could not run (no Claude account could run it), so the change waits for you."
        : HELD_TEXT[e.reason] ?? "The change waits for you.";
      create({ ...base, kind: "rules_change", title: "The manager changed its rules", body: reason, payload: { added: lines(e.lines), rulesHash: e.hash, rulesReason: e.reason } });
      return;
    }
    case "rules_decided":
      for (const row of deps.openBy("rules_change", "rulesHash", e.hash)) {
        deps.cards.transition(row.id, "answered", { by: "user", channel: "ppm", at: deps.now(), note: e.action === "approve" ? "Change approved" : "Change reverted" });
      }
      return;
  }
}

export function budgetEventCard(deps: EventCardsDeps, e: AssistantBudgetEvent): void {
  const open = deps.openBy("budget", "assistantSessionId", e.sessionId);
  if (e.type === "resumed") {
    for (const row of open) deps.cards.transition(row.id, "resolved", { by: "user", channel: "ppm", at: deps.now(), note: "Resumed when you wrote" });
    return;
  }
  if (open.length) return;
  deps.cards.create({
    kind: "budget", projectName: null, projectPath: null, sessionId: null,
    title: "PPM Assistant paused messaging manager chats",
    body: `It stopped because ${BUDGET_TEXT[e.reason] ?? "a limit was reached"}. It will message them again after you next write to it.`,
    payload: { assistantSessionId: e.sessionId },
  });
  log.info(`budget card for ${e.sessionId} (${e.reason})`);
}
