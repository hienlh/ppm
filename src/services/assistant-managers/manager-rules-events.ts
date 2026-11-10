/**
 * What happened to a project's manager rules, for whoever turns it into something the user sees
 * (the Assistant's cards). Emitted in-process, after the change is stored; a listener that throws
 * is logged and never fails the guard.
 */
import { createLogger } from "../logger.ts";

const log = createLogger("manager-rules");

interface Base {
  projectKey: string;
  projectName: string;
  /** The project's manager chat. */
  sessionId: string;
}

export type RulesHeldReason =
  | "existing_file" | "removed" | "structural" | "keyword" | "too_complex" | "too_large"
  | "relaxes_or_unclear" | "check_failed";

export type ManagerRulesEvent =
  /** The manager added lines PPM let through, quoted verbatim. */
  | (Base & { type: "rules_tightened"; lines: string[] })
  /** The user's own edit (Settings): never a decision, always said, so a write they did not make shows. */
  | (Base & { type: "rules_edited"; added: string[]; removed: string[]; fetchSite: string | null })
  /** A change held for the user; once per distinct change. `lines` are the ones that held it. */
  | (Base & { type: "rules_loosen_pending"; hash: string; reason: RulesHeldReason; lines: string[]; detail?: string })
  /** The file was missing and PPM wrote the rules in force back. */
  | (Base & { type: "rules_restored" })
  /** The file cannot be read as rules (a link, not a file, tracked by git…); the stored rules stay in force. */
  | (Base & { type: "rules_unreadable"; reason: string; message: string })
  /** A held change was approved or reverted. */
  | (Base & { type: "rules_decided"; action: "approve" | "revert"; hash: string });

type Listener = (event: ManagerRulesEvent) => void;
const listeners = new Set<Listener>();

export const managerRulesEvents = {
  on(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  emit(event: ManagerRulesEvent): void {
    log.info(`${event.type} project=${event.projectName} session=${event.sessionId}`
      + ("reason" in event ? ` reason=${event.reason}` : "")
      + ("hash" in event ? ` hash=${event.hash.slice(0, 12)}` : ""));
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (e) {
        log.warn(`a ${event.type} listener failed: ${(e as Error).message}`);
      }
    }
  },
};
