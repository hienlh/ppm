/**
 * Going to a path the user typed or pasted into the explorer's path field, on desktop and phone.
 *
 * A folder opens; a file opens its folder with the file selected (pasting a file's path is as
 * common as pasting a folder's); anything else stays where it was and says why in plain words,
 * instead of moving the window to a path that lists nothing under a raw `ENOENT: …` line.
 *
 * The user's own rules apply (`/api/fs/stat`: PPM's folder refused, every drive allowed), not the
 * stricter ones for a path somebody else named: this is the user typing.
 */

import { useCallback, useState } from "react";
import { fsApi, FsError } from "@/lib/fs-api";
import { useExplorerStore } from "./explorer-store";
import { parentOf } from "./host-path-parts";
import type { ExplorerNavigation } from "./use-explorer-navigation";

/** What the path field reports after a submit: null when it navigated. */
export type TypedPathError = string | null;

/** Plain words for why a typed path cannot be opened. */
export function typedPathError(raw: string, e: unknown): string {
  const code = e instanceof FsError ? e.code : undefined;
  if (code === "ENOENT") return `No folder or file at ${raw}.`;
  // Both a path off this machine's drives and PPM's own folder answer EDENIED.
  if (code === "EDENIED" || code === "EPROTECTED") return `PPM does not open ${raw}.`;
  if (code === "EACCES" || code === "EPERM") return `PPM is not allowed to read ${raw}.`;
  return e instanceof Error && e.message ? `${raw}: ${e.message}` : `PPM could not open ${raw}.`;
}

/**
 * `submit(raw)` resolves the typed path and navigates; it answers the error to show, or null.
 * `pending` is true while the check runs, so the field can hold its text.
 */
export function useTypedPath(windowId: string, nav: ExplorerNavigation) {
  const [pending, setPending] = useState(false);
  const submit = useCallback(async (input: string): Promise<TypedPathError> => {
    const raw = input.trim();
    if (!raw) return "Type a folder or file path.";
    setPending(true);
    try {
      const entry = await fsApi.stat(raw);
      if (entry.kind === "file") {
        const dir = parentOf(entry.path);
        if (!dir) return `PPM could not open ${raw}.`;
        nav.go(dir);
        // `go` clears the selection; setting it after leaves the file selected and the list
        // scrolled to it once the folder is listed.
        useExplorerStore.getState().patch(windowId, { selection: new Set([entry.path]), anchor: entry.path });
        return null;
      }
      // A folder, or a link (the listing follows it, and says so if it does not lead to one).
      nav.go(entry.path);
      return null;
    } catch (e) {
      return typedPathError(raw, e);
    } finally {
      setPending(false);
    }
  }, [windowId, nav]);
  return { submit, pending };
}
