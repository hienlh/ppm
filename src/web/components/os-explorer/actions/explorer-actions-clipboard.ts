/**
 * Cut / copy / paste against the real filesystem, plus the collision prompt.
 *
 * The clipboard itself lives in `file-store` and holds absolute paths, so a cut in the
 * project tree can be pasted into an explorer window and the other way round. Everything
 * here goes through `/api/fs/*`; the tree keeps its project-scoped routes for the case
 * where both ends are inside the same project.
 */

import { toast } from "sonner";
import { fsApi, FsError } from "@/lib/fs-api";
import { useFileStore, type ClipboardState } from "@/stores/file-store";
import { dirnameOf, joinPath, suffixName } from "../format-file-meta";
import { fsChanged } from "../explorer-store";

export type CollisionChoice = "replace" | "keep-both" | "skip";

export interface CollisionRequest {
  name: string;
  destination: string;
}

/** Asks the user what to do about an existing file. Returning "skip" is always safe. */
export type CollisionResolver = (request: CollisionRequest) => Promise<CollisionChoice>;

export interface TransferContext {
  sep: string;
  resolve: CollisionResolver;
}

export interface TransferResult {
  succeeded: number;
  skipped: number;
  failed: number;
}

/** Highest "name (n)" suffix tried before giving up on a free name. */
const MAX_KEEP_BOTH_ATTEMPTS = 99;

async function pathExists(path: string): Promise<boolean> {
  try {
    await fsApi.stat(path);
    return true;
  } catch (e) {
    if (e instanceof FsError && e.code === "ENOENT") return false;
    // Anything else (permission, protected root) is not a free name either.
    return true;
  }
}

async function freeName(dir: string, name: string, sep: string): Promise<string | null> {
  for (let n = 2; n <= MAX_KEEP_BOTH_ATTEMPTS; n++) {
    const candidate = suffixName(name, n);
    if (!(await pathExists(joinPath(dir, candidate, sep)))) return candidate;
  }
  return null;
}

async function runOne(source: string, destination: string, op: "copy" | "move"): Promise<void> {
  if (op === "copy") await fsApi.copy(source, destination);
  else await fsApi.move(source, destination);
}

/**
 * Copy or move `sources` into `dstDir`.
 *
 * Exported on its own (not just through the clipboard) because drag-and-drop performs the
 * exact same operation with a different trigger.
 */
export async function transfer(
  sources: string[],
  dstDir: string,
  op: "copy" | "move",
  ctx: TransferContext,
): Promise<TransferResult> {
  const result: TransferResult = { succeeded: 0, skipped: 0, failed: 0 };
  const touched = new Set<string>([dstDir]);

  for (const source of sources) {
    const name = source.split(/[/\\]/).filter(Boolean).pop() ?? source;
    const sourceDir = dirnameOf(source, ctx.sep);
    touched.add(sourceDir);
    // Moving an entry into the folder it already lives in is a no-op, not an error.
    if (op === "move" && sourceDir === dstDir) {
      result.skipped++;
      continue;
    }

    let destination = joinPath(dstDir, name, ctx.sep);
    try {
      await runOne(source, destination, op);
      result.succeeded++;
      continue;
    } catch (e) {
      if (!(e instanceof FsError) || e.code !== "EEXIST") {
        result.failed++;
        toast.error(`${op === "copy" ? "Copy" : "Move"} failed: ${name}`, {
          description: e instanceof Error ? e.message : undefined,
        });
        continue;
      }
    }

    const choice = await ctx.resolve({ name, destination });
    if (choice === "skip") {
      result.skipped++;
      continue;
    }
    try {
      if (choice === "keep-both") {
        const alternative = await freeName(dstDir, name, ctx.sep);
        if (!alternative) throw new Error("No free name available");
        destination = joinPath(dstDir, alternative, ctx.sep);
      } else {
        // Replace: the existing entry goes to the trash first, so an overwrite stays
        // recoverable and the server never has to force a destructive copy.
        await fsApi.remove(destination, false);
      }
      await runOne(source, destination, op);
      result.succeeded++;
    } catch (e) {
      result.failed++;
      toast.error(`${op === "copy" ? "Copy" : "Move"} failed: ${name}`, {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  }

  fsChanged(...touched);
  return result;
}

/** Put absolute paths on the shared clipboard. `origin` lets the tree keep its own routes. */
export function setClipboardPaths(
  paths: string[],
  operation: "cut" | "copy",
  origin?: ClipboardState["origin"],
): void {
  if (paths.length === 0) return;
  useFileStore.getState().setClipboard({ paths: [...paths], operation, origin });
}

/** Paste the shared clipboard into `dstDir`. A cut clipboard is consumed on success. */
export async function pasteInto(dstDir: string, ctx: TransferContext): Promise<void> {
  const clipboard = useFileStore.getState().clipboard;
  if (!clipboard || clipboard.paths.length === 0) return;

  const result = await transfer(clipboard.paths, dstDir, clipboard.operation === "cut" ? "move" : "copy", ctx);
  if (clipboard.operation === "cut" && result.failed === 0) {
    useFileStore.getState().setClipboard(null);
  }
  if (result.succeeded > 0) {
    const verb = clipboard.operation === "cut" ? "Moved" : "Copied";
    toast.success(`${verb} ${result.succeeded} item${result.succeeded === 1 ? "" : "s"}`);
  }
}
