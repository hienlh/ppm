/**
 * Diagnostics from every open file, in one place.
 *
 * `useLsp` already turns a file's diagnostics into Monaco markers, which is
 * what draws the squiggles. Those are per-model though, so nothing can answer
 * "what is wrong in this project" — the question the Problems panel exists for.
 * Each editor publishes here as well, and the panel reads the union.
 *
 * The scope is deliberately the files that are open. LSP publishes diagnostics
 * per open document, so a closed file's problems are not something the server
 * has told us about, and listing stale ones from a previous session would be
 * worse than listing none.
 */
import { create } from "zustand";
import type { LspDiagnostic } from "@/hooks/use-lsp";

export interface FileProblems {
  projectName: string;
  /** Project-relative path. */
  filePath: string;
  diagnostics: LspDiagnostic[];
}

/** LSP severities, spelled out because the numbers are not self-explanatory. */
export const SEVERITY_ERROR = 1;
export const SEVERITY_WARNING = 2;

interface ProblemsState {
  /** Keyed by project and path, so two projects cannot collide on a filename. */
  files: Record<string, FileProblems>;
  publish: (projectName: string, filePath: string, diagnostics: LspDiagnostic[]) => void;
  clear: (projectName: string, filePath: string) => void;
}

/**
 * A project name can contain a space, so a space separator would let
 * ("app b", "c.ts") and ("app", "b/c.ts") collide on one key. NUL cannot appear
 * in either, and is written as an escape so it is visible in the source.
 */
export const problemKey = (projectName: string, filePath: string) => `${projectName}\u0000${filePath}`;

export const useProblemsStore = create<ProblemsState>((set) => ({
  files: {},

  publish: (projectName, filePath, diagnostics) =>
    set((state) => {
      const key = problemKey(projectName, filePath);
      // A file that has been fixed publishes an empty list. Dropping the entry
      // rather than storing an empty one keeps the panel's "no problems" state
      // honest and stops it listing files with nothing under them.
      if (diagnostics.length === 0) {
        if (!state.files[key]) return state;
        const { [key]: _removed, ...rest } = state.files;
        return { files: rest };
      }
      return { files: { ...state.files, [key]: { projectName, filePath, diagnostics } } };
    }),

  clear: (projectName, filePath) =>
    set((state) => {
      const key = problemKey(projectName, filePath);
      if (!state.files[key]) return state;
      const { [key]: _removed, ...rest } = state.files;
      return { files: rest };
    }),
}));

/**
 * Only one project's files.
 *
 * Editor tabs from other projects stay mounted for keep-alive, so their
 * language servers keep publishing and the store holds more than one project at
 * a time. Every view of this data is project-scoped, like the rest of PPM.
 */
export function filesForProject(
  files: Record<string, FileProblems>,
  projectName: string | null,
): Record<string, FileProblems> {
  if (!projectName) return files;
  return Object.fromEntries(
    Object.entries(files).filter(([, file]) => file.projectName === projectName),
  );
}

/** Totals across every open file, for the panel header and the tab badge. */
export function problemCounts(files: Record<string, FileProblems>): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const file of Object.values(files)) {
    for (const diagnostic of file.diagnostics) {
      if (diagnostic.severity === SEVERITY_ERROR) errors++;
      else if (diagnostic.severity === SEVERITY_WARNING) warnings++;
    }
  }
  return { errors, warnings };
}

/**
 * Files in a stable order, each with its diagnostics sorted by position.
 *
 * Sorted rather than left in arrival order: the panel is read top to bottom
 * against the file, and a list that reshuffles whenever a server republishes
 * cannot be used that way.
 */
export function sortedProblems(files: Record<string, FileProblems>): FileProblems[] {
  return Object.values(files)
    .map((file) => ({
      ...file,
      diagnostics: [...file.diagnostics].sort(
        (a, b) =>
          a.range.start.line - b.range.start.line ||
          a.range.start.character - b.range.start.character,
      ),
    }))
    .sort((a, b) => a.filePath.localeCompare(b.filePath));
}
