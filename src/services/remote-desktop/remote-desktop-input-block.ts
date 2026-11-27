/**
 * Why a Windows input event did not reach anything, decided from what the send could observe.
 *
 * Three ways, and only two of them are visible from SendInput itself:
 * - `desktop`: the thread could not attach to the input desktop (the lock screen or a UAC prompt).
 * - `rejected`: SendInput accepted fewer events than it was given.
 * - `elevated-window`: the window in front belongs to a process at a higher integrity level than
 *   PPM (an app run as administrator). Windows' UIPI then drops every injected event — mouse and
 *   keyboard, Alt+Tab included — while SendInput still reports that it sent all of them. Found
 *   on a real host: WireGuard's window (High, 0x3000) in front of a PPM at Medium (0x2000), the
 *   stream fine and the pointer frozen, with nothing in the log.
 *
 * Pure, so the decision is tested without a desktop; `remote-desktop-win32-integrity.ts` reads
 * the levels.
 */

/** A token's mandatory integrity level, the RID of its label SID: Medium = 0x2000, High = 0x3000. */
export const INTEGRITY = { low: 0x1000, medium: 0x2000, high: 0x3000, system: 0x4000 } as const;

export interface ForegroundProcess {
  pid: number;
  /** Executable file name, when it could be read. */
  exe: string | null;
  /** Null when the process's token cannot be opened from PPM, which itself means it outranks PPM
   *  (an elevated process of the same user refuses a Medium caller). */
  integrity: number | null;
}

export type InputBlockReason = "desktop" | "rejected" | "elevated-window";

export function classifyInputBlock(s: {
  attached: boolean;
  sent: number;
  count: number;
  /** Null when there is no foreground window, or it could not be identified. */
  foreground: ForegroundProcess | null;
  /** PPM's own level; null when it could not be read (then nothing is concluded from it). */
  ownIntegrity: number | null;
}): InputBlockReason | null {
  if (!s.attached) return "desktop";
  if (s.sent !== s.count) return "rejected";
  if (s.foreground && s.ownIntegrity !== null) {
    const fg = s.foreground.integrity;
    if (fg === null || fg > s.ownIntegrity) return "elevated-window";
  }
  return null;
}

/** What the viewer is told: only the block a user can do something about from where they are.
 *  The lock screen and the secure desktop have their own visible signs on the stream. */
export interface InputBlockNotice {
  reason: "elevated-window";
  /** File name of the administrator app in front, when it could be read. */
  app: string | null;
}

export function noticeFor(reason: InputBlockReason | null, fg: ForegroundProcess | null): InputBlockNotice | null {
  return reason === "elevated-window" ? { reason, app: fg?.exe ?? null } : null;
}

let current: InputBlockNotice | null = null;
const listeners = new Set<(notice: InputBlockNotice | null) => void>();

/** The block in force now (null = input gets through), for a session that starts mid-block. */
export function currentInputBlock(): InputBlockNotice | null {
  return current;
}

/** Called with every change, including the change back to null once input gets through again. */
export function onInputBlockChange(listener: (notice: InputBlockNotice | null) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The input backend reports each change of state here; repeats are dropped. */
export function publishInputBlock(notice: InputBlockNotice | null): void {
  if (notice?.reason === current?.reason && notice?.app === current?.app) return;
  current = notice;
  for (const listener of listeners) {
    try { listener(notice); } catch { /* a closed session must not stop the others */ }
  }
}

/** Tests only. */
export function resetInputBlockForTests(): void {
  current = null;
  listeners.clear();
}

/** One log line per change of state, saying what to do about it. */
export function describeInputBlock(reason: InputBlockReason, sent: number, count: number, fg: ForegroundProcess | null): string {
  if (reason === "desktop") return "input blocked: cannot reach input desktop";
  if (reason === "rejected") return `input blocked: SendInput accepted ${sent}/${count} events`;
  const who = fg?.exe ? `${fg.exe} (pid ${fg.pid})` : `pid ${fg?.pid ?? "?"}`;
  return `input blocked: the window in front, ${who}, runs as administrator, and Windows drops remote input `
    + "from a non-administrator process while it has focus (even Alt+Tab). Bring another window to the front "
    + "on the PC, or run that app without administrator rights.";
}
