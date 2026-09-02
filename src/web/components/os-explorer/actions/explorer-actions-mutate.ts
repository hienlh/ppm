/**
 * Disk mutations: new file / new folder, rename, and the two delete flavours.
 *
 * Deleting goes to the OS trash by default. When the host has no trash backend the server
 * answers `NO_TRASH` and the caller is told to offer a permanent delete instead of failing
 * with a message the user cannot act on.
 */

import { toast } from "sonner";
import { fsApi, FsError } from "@/lib/fs-api";
import { dirnameOf, errorDescription, joinPath } from "../format-file-meta";
import { fsChanged } from "../explorer-store";

/** Characters Windows refuses in a file name. */
const WINDOWS_ILLEGAL = /[<>:"|?*]/;
/** Control characters are illegal in a name on every platform. */
const CONTROL_CHARS = /[\u0000-\u001f]/;
/** Device names Windows reserves, with or without an extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Validate a bare entry name. Returns an error message, or null when the name is usable.
 * The server enforces the same rules; checking here keeps the inline input responsive.
 */
export function validateEntryName(name: string, platform: string | undefined): string | null {
  if (!name) return "Name cannot be empty";
  if (name === "." || name === "..") return "Reserved name";
  if (name.includes("/") || name.includes("\\")) return "Name cannot contain path separators";
  if (CONTROL_CHARS.test(name)) return "Invalid character in name";
  if (platform === "win32") {
    if (WINDOWS_ILLEGAL.test(name)) return 'Cannot contain < > : " | ? *';
    if (WINDOWS_RESERVED.test(name)) return `"${name}" is a reserved Windows name`;
    // Windows silently strips these, so the created entry would not be the one asked for.
    if (name.endsWith(".") || name.endsWith(" ")) return "Cannot end with a dot or space";
  }
  return null;
}

export async function createEntry(
  dir: string,
  name: string,
  kind: "file" | "folder",
  sep: string,
): Promise<boolean> {
  const path = joinPath(dir, name, sep);
  try {
    // `gitInit: false` — an explorer folder is a folder, not a new repository.
    if (kind === "folder") await fsApi.mkdir(path, false);
    else await fsApi.touch(path);
    fsChanged(dir);
    return true;
  } catch (e) {
    toast.error(kind === "folder" ? "Could not create folder" : "Could not create file", {
      description: errorDescription(e),
    });
    return false;
  }
}

export async function renameEntry(path: string, newName: string, sep: string): Promise<boolean> {
  try {
    await fsApi.rename(path, newName);
    fsChanged(dirnameOf(path, sep));
    return true;
  } catch (e) {
    toast.error("Rename failed", { description: errorDescription(e) });
    return false;
  }
}

export interface DeleteOutcome {
  removed: number;
  /** Paths the host could not trash — the caller offers a permanent delete for these. */
  needsPermanent: string[];
}

/**
 * Delete `paths`. With `permanent` false this moves them to the OS trash and any path the
 * host cannot trash is reported back rather than removed behind the user's back.
 */
export async function deleteEntries(
  paths: string[],
  permanent: boolean,
  sep: string,
): Promise<DeleteOutcome> {
  const outcome: DeleteOutcome = { removed: 0, needsPermanent: [] };
  const touched = new Set<string>();

  for (const path of paths) {
    touched.add(dirnameOf(path, sep));
    try {
      await fsApi.remove(path, permanent);
      outcome.removed++;
    } catch (e) {
      if (e instanceof FsError && e.code === "NO_TRASH") {
        outcome.needsPermanent.push(path);
        continue;
      }
      toast.error("Delete failed", { description: errorDescription(e) });
    }
  }

  fsChanged(...touched);
  if (outcome.removed > 0) {
    const noun = `${outcome.removed} item${outcome.removed === 1 ? "" : "s"}`;
    toast.success(permanent ? `Deleted ${noun}` : `Moved ${noun} to Trash`);
  }
  return outcome;
}
