/**
 * Which session schedules wait to be sent into which chat, in memory. The database stays the
 * source of truth (`pending_since`): every read goes back to it, so a schedule edited, paused or
 * deleted while it waited simply drops out here, and after a restart the scheduler hands every
 * pending fire over again.
 */
import { getSchedule } from "../scheduler-db.service.ts";
import type { Schedule } from "../../types/scheduler.ts";
import { deliverable } from "./session-schedule-dispatch-types.ts";

export class SessionScheduleWaitingList {
  private readonly byChat = new Map<string, Set<number>>();

  add(sessionId: string, scheduleId: number): void {
    let ids = this.byChat.get(sessionId);
    if (!ids) this.byChat.set(sessionId, ids = new Set());
    ids.add(scheduleId);
  }

  has(sessionId: string): boolean {
    return this.byChat.has(sessionId);
  }

  /** The chat's waiting schedule whose fire came due first; those that can no longer fire drop out. */
  next(sessionId: string): Schedule | null {
    const ready = this.deliverableOf(sessionId);
    ready.sort((a, b) => a.pending_since!.localeCompare(b.pending_since!) || a.id - b.id);
    return ready[0] ?? null;
  }

  /** Every schedule still waiting for the chat, removed from the list. */
  takeAll(sessionId: string): Schedule[] {
    const ready = this.deliverableOf(sessionId);
    this.byChat.delete(sessionId);
    return ready;
  }

  drop(sessionId: string, scheduleId: number): void {
    const ids = this.byChat.get(sessionId);
    ids?.delete(scheduleId);
    if (ids?.size === 0) this.byChat.delete(sessionId);
  }

  /** The chat was renamed: what waited under the old id waits under the new one. */
  rename(oldId: string, newId: string): void {
    const ids = this.byChat.get(oldId);
    if (!ids) return;
    this.byChat.delete(oldId);
    for (const id of ids) this.add(newId, id);
  }

  clear(): void {
    this.byChat.clear();
  }

  private deliverableOf(sessionId: string): Schedule[] {
    const ids = this.byChat.get(sessionId);
    if (!ids) return [];
    const ready: Schedule[] = [];
    for (const id of [...ids]) {
      const schedule = getSchedule(id);
      if (deliverable(schedule)) ready.push(schedule);
      else ids.delete(id);
    }
    if (ids.size === 0) this.byChat.delete(sessionId);
    return ready;
  }
}
