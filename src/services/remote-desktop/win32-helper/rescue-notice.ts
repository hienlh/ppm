/**
 * Whether the safety net actually did something the user should hear about.
 *
 * The viewer no longer asks anyone to confirm: it confirms by itself once a picture comes
 * through (`use-picture-proof.ts`). So the only time the net is worth a word is when its
 * `Rescue` task ran because nobody saw the PC for `RESCUE_MINUTES`, and turned the virtual
 * display on (or found no driver to turn on). That is read from `state\last-run.json`, which the
 * SYSTEM helper writes after every run: any later run (a confirm, a reattach, the display turned
 * off again) replaces it, and with it the notice, because what it described is no longer the
 * PC's state.
 */
import { helperPaths } from "./helper-paths.ts";
import { helperSystem } from "./helper-system.ts";
import { parseJson } from "./helper-json.ts";

/** What the `Rescue` task did: turned the virtual display on, or had no driver to turn on. */
export interface RescueNotice {
  /** When it ran (ISO, from the helper): also the key the viewer dismisses it by. */
  at: string;
  outcome: "display-on" | "no-driver";
}

/** Older than this, the notice explains nothing the user is looking at any more. */
export const RESCUE_NOTICE_MAX_AGE_MS = 24 * 60 * 60_000;

/** `last-run.json` → the notice, or null when the last run was anything else. Pure. */
export function rescueNoticeFrom(lastRun: unknown, nowMs: number): RescueNotice | null {
  const run = lastRun as { action?: unknown; ok?: unknown; message?: unknown; at?: unknown } | null;
  if (!run || run.action !== "Rescue" || run.ok !== true) return null;
  if (typeof run.message !== "string" || typeof run.at !== "string") return null;
  // "Nothing was waiting" and "Not due yet" are runs where the net did nothing.
  if (!run.message.startsWith("Safety net ran:")) return null;
  const at = Date.parse(run.at);
  if (!Number.isFinite(at) || nowMs - at > RESCUE_NOTICE_MAX_AGE_MS) return null;
  if (run.message.includes("Turned the virtual display on")) return { at: run.at, outcome: "display-on" };
  if (run.message.includes("No virtual display driver")) return { at: run.at, outcome: "no-driver" };
  // "The session at this PC has a screen": the net looked and nothing needed doing.
  return null;
}

/** Cheap enough to poll beside the rescue record: one small file read, no process. */
export function getRescueNotice(): RescueNotice | null {
  const sys = helperSystem();
  if (sys.platform !== "win32") return null;
  return rescueNoticeFrom(parseJson(sys.readText(helperPaths().lastRun)), sys.now());
}
