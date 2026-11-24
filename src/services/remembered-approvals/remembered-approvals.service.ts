import { createLogger } from "../logger.ts";
import { configService } from "../config.service.ts";
import { projectKey } from "../project-name-for-path.ts";
import type { ChatMessageOrigin } from "../chat-control/chat-control.ts";
import {
  approvalPatternFor, matchesRule, type ApprovalPattern, type ApprovalRequestShape,
} from "../../shared/remembered-approval-pattern.ts";
import {
  REMEMBER_SUGGEST_AFTER, type CardRememberOffer, type RememberedApprovalRule,
} from "../../shared/remembered-approvals.ts";
import {
  approvalTally, deleteApprovalRule, insertApprovalRule, listApprovalRules, tallyApproval, touchApprovalRule,
  type ApprovalRuleRow,
} from "./remembered-approvals-db.ts";

/**
 * Remembered approvals: kinds of request the user chose, on a card, to have approved without a
 * card from then on, in that project only.
 *
 * - Only a person's press makes a rule: the user in the chat, on the PPM Assistant's mirror of the
 *   card, or on Telegram. Nothing an AI does (the Assistant answering another chat's card, a tool,
 *   a script) can make, change or remove one; there is no tool for it at all.
 * - The pattern is worked out on the server from the request (`remembered-approval-pattern.ts`),
 *   and every refusal is decided again on every request.
 * - Off as a whole until the user turns it on (Settings, or the tour's question); turned off, no
 *   rule approves anything and no card offers to remember, but the rules are kept.
 * - After the user approved the same pattern by hand {@link REMEMBER_SUGGEST_AFTER} times, its
 *   card suggests remembering it. Nothing is remembered without the press.
 */

const log = createLogger("remembered-approvals");

/** The surfaces where a person presses a card's button. */
const PERSON_ORIGINS: ReadonlySet<ChatMessageOrigin> = new Set<ChatMessageOrigin>(["ws", "assistant_card", "telegram"]);

/** A card's request, with where it was asked. */
export interface RememberRequest extends ApprovalRequestShape {
  projectName: string;
}

export interface RememberedApprovalsDeps {
  now(): number;
  enabled(): boolean;
  setEnabled(on: boolean): void;
  /** Rules and switch changed: every PPM tab's Settings list refreshes. */
  changed?(): void;
}

const realDeps: RememberedApprovalsDeps = {
  now: () => Date.now(),
  enabled: () => configService.get("remembered_approvals")?.enabled === true,
  setEnabled: (on) => configService.set("remembered_approvals", { ...(configService.get("remembered_approvals") ?? {}), enabled: on }),
};

let onChanged: (() => void) | null = null;

/** Who hears that the rules or the switch changed (the server's `/ws/global` broadcast). */
export function setRememberedApprovalsChanged(fn: (() => void) | null): void {
  onChanged = fn;
}

export function toRule(row: ApprovalRuleRow): RememberedApprovalRule {
  return {
    id: row.id, projectName: row.projectName, kind: row.kind, pattern: row.pattern, label: row.label,
    createdAt: row.createdAt, createdVia: row.createdVia, lastUsedAt: row.lastUsedAt, useCount: row.useCount,
  };
}

export function createRememberedApprovals(deps: RememberedApprovalsDeps = realDeps) {
  const tell = () => {
    try { (deps.changed ?? onChanged)?.(); } catch (e) { log.warn(`could not announce a rules change: ${(e as Error).message}`); }
  };
  const keyOf = (req: { projectPath: string }) => projectKey(req.projectPath);

  return {
    enabled: (): boolean => {
      try { return deps.enabled(); } catch { return false; }
    },

    setEnabled(on: boolean): void {
      deps.setEnabled(on);
      log.info(`remembered approvals turned ${on ? "on" : "off"}`);
      tell();
    },

    /**
     * The rule that approves this request now, if any. Never for an extension's turn (it answers
     * its own cards) or when the feature is off.
     */
    ruleFor(req: RememberRequest, turnOrigin?: ChatMessageOrigin): ApprovalRuleRow | null {
      if (!this.enabled() || turnOrigin === "extension" || !req.projectPath) return null;
      let rules: ApprovalRuleRow[];
      try { rules = listApprovalRules(keyOf(req)); } catch (e) {
        log.warn(`rules unreadable, asking instead: ${(e as Error).message}`);
        return null;
      }
      const rule = rules.find((r) => matchesRule(r, req)) ?? null;
      if (rule) {
        try { touchApprovalRule(rule.id, deps.now()); } catch { /* the count is only shown */ }
      }
      return rule;
    },

    /** What a card offers to remember, and whether it suggests it; null when it offers nothing. */
    offerFor(req: RememberRequest): CardRememberOffer | null {
      if (!this.enabled() || !req.projectPath) return null;
      const pattern = approvalPatternFor(req);
      if (!pattern) return null;
      let approvals = 0;
      try { approvals = approvalTally(keyOf(req), pattern.kind, pattern.pattern); } catch { /* no suggestion */ }
      return { label: pattern.label, suggest: approvals >= REMEMBER_SUGGEST_AFTER };
    },

    /**
     * A person answered a card: an approval counts towards the suggestion, and `remember` makes the
     * rule. Anything not pressed by a person counts for nothing. Returns the rule made, if any.
     */
    recordAnswer(req: RememberRequest, a: { approved: boolean; remember?: boolean; origin: ChatMessageOrigin }): RememberedApprovalRule | null {
      if (!a.approved || !PERSON_ORIGINS.has(a.origin) || !this.enabled() || !req.projectPath) return null;
      const pattern: ApprovalPattern | null = approvalPatternFor(req);
      if (!pattern) return null;
      const at = deps.now();
      try { tallyApproval(keyOf(req), pattern.kind, pattern.pattern, at); } catch (e) { log.warn(`could not count an approval: ${(e as Error).message}`); }
      if (!a.remember) return null;
      const { row, created } = insertApprovalRule({
        projectKey: keyOf(req), projectName: req.projectName, kind: pattern.kind, pattern: pattern.pattern, label: pattern.label,
        createdAt: at, createdVia: a.origin === "ws" ? "chat" : a.origin,
      });
      if (created) {
        log.info(`rule ${row.id} remembered in ${req.projectName}: ${pattern.kind} "${pattern.pattern}" (pressed on ${row.createdVia})`);
        tell();
      }
      return toRule(row);
    },

    list(): RememberedApprovalRule[] {
      return listApprovalRules().map(toRule);
    },

    remove(id: string): boolean {
      const gone = deleteApprovalRule(id);
      if (gone) {
        log.info(`rule ${id} removed`);
        tell();
      }
      return gone;
    },
  };
}

export type RememberedApprovals = ReturnType<typeof createRememberedApprovals>;

export const rememberedApprovals = createRememberedApprovals();
