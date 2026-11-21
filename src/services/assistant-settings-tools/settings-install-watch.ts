import { createLogger } from "../logger.ts";
import type { SettingChangeOrigin } from "../../shared/assistant-settings-changes.ts";
import type { InstallComponent } from "./settings-installs.ts";

/**
 * Follows a background install the Assistant started (Whisper, the relay) until it ends, and tells
 * listeners at each step — Telegram edits one message with it. The chat card reads the installer's
 * own status route instead, so nothing here is needed for PPM's screens.
 */

const log = createLogger("assistant-settings-install");
const POLL_MS = 2_000;
/** A download that has not ended after this long is no longer followed (the installer keeps going). */
const GIVE_UP_MS = 60 * 60_000;

export interface InstallProgress {
  id: string;
  sessionId: string | null;
  origin: SettingChangeOrigin;
  label: string;
  receivedBytes: number;
  totalBytes: number;
  done: boolean;
  error: string | null;
}

type Listener = (p: InstallProgress) => void;
const listeners = new Set<Listener>();

export const installProgressEvents = {
  on(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

function emit(p: InstallProgress): void {
  for (const l of [...listeners]) {
    try { l(p); } catch (e) { log.warn(`install progress listener failed: ${(e as Error).message}`); }
  }
}

export function watchInstall(opts: {
  component: InstallComponent; option: string | null; label: string; sessionId: string | null; origin: SettingChangeOrigin;
  pollMs?: number; now?: () => number;
}): void {
  const id = crypto.randomUUID();
  const now = opts.now ?? Date.now;
  const started = now();
  const tick = async (): Promise<void> => {
    let status;
    try {
      status = await opts.component.status(opts.option);
    } catch (e) {
      log.warn(`could not read ${opts.label}'s install status: ${(e as Error).message}`);
      return;
    }
    const base = { id, sessionId: opts.sessionId, origin: opts.origin, label: opts.label };
    if (status.running) {
      emit({ ...base, receivedBytes: status.running.receivedBytes, totalBytes: status.running.totalBytes, done: false, error: null });
      if (now() - started < GIVE_UP_MS) setTimeout(() => void tick(), opts.pollMs ?? POLL_MS);
      return;
    }
    emit({ ...base, receivedBytes: 0, totalBytes: 0, done: true, error: status.installed ? null : (status.error ?? "The install stopped before it finished.") });
  };
  setTimeout(() => void tick(), opts.pollMs ?? POLL_MS);
}
