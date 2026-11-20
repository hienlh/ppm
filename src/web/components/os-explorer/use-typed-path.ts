/**
 * Going to a path the user typed or pasted into the explorer's path field, on desktop and phone.
 *
 * A folder opens; a file opens its folder with the file selected (pasting a file's path is as
 * common as pasting a folder's); a link is followed to what it names; a relative path is read
 * from the folder on screen; anything else stays where it was and says why in plain words,
 * instead of moving the window to a path that lists nothing under a raw `ENOENT: …` line.
 *
 * The user's own rules apply (`/api/fs/stat`: PPM's folder refused, every drive allowed), not the
 * stricter ones for a path somebody else named: this is the user typing.
 */

import { useCallback, useState } from "react";
import { fsApi, FsError, type FsStatResult } from "@/lib/fs-api";
import { useExplorerStore } from "./explorer-store";
import { parentOf, sepOf } from "./host-path-parts";
import { selectWhenListed } from "./select-when-listed";
import type { ExplorerNavigation } from "./use-explorer-navigation";

/** What the path field reports after a submit: null when it navigated. */
export type TypedPathError = string | null;

/** How many links in a row are followed before giving up (a cycle, or a very long chain). */
const MAX_LINK_HOPS = 8;

const isAbsoluteHostPath = (p: string) => /^(?:[A-Za-z]:[\\/]|[\\/]|~(?:[\\/]|$))/.test(p);

/** `raw` as the server should read it: relative paths are taken from the folder on screen. */
export function typedPathTarget(raw: string, currentDir: string): string {
  if (isAbsoluteHostPath(raw) || !currentDir) return raw;
  const sep = sepOf(currentDir);
  return `${currentDir.replace(/[\\/]+$/, "")}${sep}${raw.replace(/^\.[\\/]/, "")}`;
}

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
 * The path as typed (`path`: a link stays a link, as its folder lists it) and the kind of what it
 * finally names, following links through the server one hop at a time.
 */
async function statFollowingLinks(path: string): Promise<{ path: string; kind: FsStatResult["kind"] }> {
  const first = await fsApi.stat(path);
  let entry = first;
  for (let hop = 0; entry.kind === "symlink" && entry.target && hop < MAX_LINK_HOPS; hop++) {
    const target = entry.target;
    entry = await fsApi.stat(isAbsoluteHostPath(target) ? target : typedPathTarget(target, parentOf(entry.path) ?? ""));
  }
  return { path: first.path, kind: entry.kind };
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
      const current = useExplorerStore.getState().slices[windowId]?.path ?? "";
      const entry = await statFollowingLinks(typedPathTarget(raw, current));
      if (entry.kind === "file") {
        const dir = parentOf(entry.path);
        if (!dir) return `PPM could not open ${raw}.`;
        nav.go(dir);
        // `go` clears the selection; setting it after leaves the file selected and the list
        // scrolled to it once the folder is listed, in the row's own spelling.
        selectWhenListed(windowId, entry.path);
        return null;
      }
      if (entry.kind !== "directory") return `${raw} is not a folder or a file PPM can open.`;
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
