import type { CardFile } from "../../shared/card-files.ts";
import { checkReportFilePath, type ReportFileRoots } from "./card-file-path-check.ts";
import { CardFileRefused, cardFileOf, pruneCardFiles, removeCardFile, storeCardFile, type StoredCardFile } from "./card-files-store.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("card-files");

/** What a report's `files` became: each path's copy or refusal, and the ids copied. */
export interface StagedReportFiles {
  byPath: Map<string, CardFile | { error: string }>;
  copied: string[];
}

export interface StageDeps {
  check?: typeof checkReportFilePath;
  store?: (realPath: string, name: string, projectPath: string) => Promise<StoredCardFile>;
}

/**
 * Checks and copies a report's `files` before the card is made, so the card holds PPM's copies.
 * The first file refused stops the rest: the report is refused as a whole, and nothing it copied is
 * kept (the caller removes `copied` unless a card took them).
 */
export async function stageReportFiles(paths: readonly string[], roots: ReportFileRoots, deps: StageDeps = {}): Promise<StagedReportFiles> {
  const check = deps.check ?? checkReportFilePath;
  const store = deps.store ?? storeCardFile;
  const byPath = new Map<string, CardFile | { error: string }>();
  const copied: string[] = [];
  const realSeen = new Map<string, CardFile>();
  void pruneCardFiles().catch(() => {});
  for (const path of paths) {
    if (byPath.has(path)) continue;
    const checked = check(path, roots);
    if (!checked.ok) {
      byPath.set(path, { error: checked.error });
      break;
    }
    // Two spellings of one file are one copy.
    const again = realSeen.get(checked.realPath);
    if (again) { byPath.set(path, again); continue; }
    try {
      const stored = await store(checked.realPath, checked.name, roots.projectPath);
      copied.push(stored.id);
      const file = cardFileOf(stored);
      realSeen.set(checked.realPath, file);
      byPath.set(path, file);
    } catch (e) {
      const why = e instanceof CardFileRefused ? e.message : `"${checked.name}" could not be copied (${(e as Error).message || "read failed"})`;
      if (!(e instanceof CardFileRefused)) log.warn(`could not copy a report file: ${(e as Error).message}`);
      byPath.set(path, { error: why });
      break;
    }
  }
  return { byPath, copied };
}

/** Removes copies no card took (the report was refused, merged or folded); never throws. */
export async function discardStagedFiles(ids: readonly string[]): Promise<void> {
  for (const id of ids) await removeCardFile(id);
}
