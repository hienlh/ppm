/**
 * In-process announcements of task store changes, emitted after the transaction commits. The
 * manager news, the /ws/global push and Telegram listen here. A listener's error is logged and
 * never reaches the writer: the change is already stored.
 */
import { createLogger } from "../logger.ts";
import type { Actor, HistoryKind, Via } from "../../shared/ppm-tasks.ts";

export type PpmTasksEvent =
  | { type: "task"; projectKey: string; taskIds: string[]; historyIds: number[]; actor: Actor; via: Via; kind: HistoryKind; unattended: boolean }
  | { type: "project"; projectKey: string; what: "switch" | "statuses" | "members" | "fields" | "settings"; actor: Actor; via: Via }
  /** Cached link states changed in these projects (emitted by the link-state checker). */
  | { type: "link_states"; projectKeys: string[] };

type Listener = (event: PpmTasksEvent) => void;

const log = createLogger("ppm-tasks");
const listeners = new Set<Listener>();

export const ppmTasksEvents = {
  /** Returns the unsubscribe function. */
  on(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  emit(event: PpmTasksEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (e) {
        log.warn(`a task event listener failed: ${(e as Error).message}`);
      }
    }
  },
};
