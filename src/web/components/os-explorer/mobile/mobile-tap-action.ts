/**
 * What a single tap does on the mobile sheet: there is no double-click on touch, so a
 * directory or a PPM-viewable file must open on the first tap. A file with nothing to open
 * it in has no useful "open" action, so a tap on it surfaces the same actions sheet a
 * long-press would — never a silent no-op.
 *
 * Pure so the three-way decision (directory / viewable file / opaque file) is unit-testable
 * without mounting a row.
 */

import { canOpenInPpm } from "../can-open-in-ppm";

export type MobileTapAction = "open" | "sheet";

/** `entry` only needs the two fields the decision actually reads. */
export function mobileTapAction(entry: { type: "file" | "directory"; name: string }): MobileTapAction {
  if (entry.type === "directory") return "open";
  return canOpenInPpm(entry.name) ? "open" : "sheet";
}
