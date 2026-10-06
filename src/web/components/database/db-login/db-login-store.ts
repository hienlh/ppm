/**
 * Database Log In's queue: who is waiting for a login, and for what.
 *
 * Anything that finds a connection asking for its password calls `requestDbLogin`; the one dialog
 * mounted in the app shows the first request, and the promise settles when that dialog is done —
 * with the login that worked, or null when it was closed. Two requests for the same saved
 * connection share one dialog, since the login the first one holds on the server serves both: a
 * restored layout with three tabs on one connection asks once, not three times.
 */
import { create } from "zustand";
import type { DbLoginPrompt, DbTestResult, DbTestSuccess } from "../../../../shared/db-connection-config";

export interface DbLogin {
  /** Only for a connection that asks for its login too. */
  user?: string;
  password: string;
}

export interface DbLoginRequest {
  prompt: DbLoginPrompt;
  /** Tries a login. The dialog stays open on a failure, showing the driver's words. */
  submit: (login: DbLogin, signal: AbortSignal) => Promise<DbTestResult>;
}

export interface DbLoginOutcome {
  login: DbLogin;
  result: DbTestSuccess;
}

export interface PendingDbLogin extends DbLoginRequest {
  id: number;
  promise: Promise<DbLoginOutcome | null>;
  resolve: (outcome: DbLoginOutcome | null) => void;
}

interface DbLoginState {
  queue: PendingDbLogin[];
}

export const useDbLoginStore = create<DbLoginState>(() => ({ queue: [] }));

let nextId = 1;

export function requestDbLogin(request: DbLoginRequest): Promise<DbLoginOutcome | null> {
  const savedId = request.prompt.connectionId;
  if (savedId !== null) {
    const same = useDbLoginStore.getState().queue.find((p) => p.prompt.connectionId === savedId);
    if (same) return same.promise;
  }
  let resolve!: (outcome: DbLoginOutcome | null) => void;
  const promise = new Promise<DbLoginOutcome | null>((r) => { resolve = r; });
  const pending: PendingDbLogin = { ...request, id: nextId++, promise, resolve };
  useDbLoginStore.setState((s) => ({ queue: [...s.queue, pending] }));
  return promise;
}

/** Ends the request the dialog shows, and brings up the next one. */
export function settleDbLogin(id: number, outcome: DbLoginOutcome | null): void {
  const pending = useDbLoginStore.getState().queue.find((p) => p.id === id);
  if (!pending) return;
  useDbLoginStore.setState((s) => ({ queue: s.queue.filter((p) => p.id !== id) }));
  pending.resolve(outcome);
}
