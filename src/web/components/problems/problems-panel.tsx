/**
 * Every diagnostic from every open file, grouped by file — VS Code's Problems
 * panel.
 *
 * The squiggles in the editor already say what is wrong with the file in front
 * of you. This answers the other question: what is wrong anywhere. Without it,
 * an error in a file you are not looking at is invisible until you happen to
 * open it, which is the failure mode a Problems list exists to remove.
 *
 * It lives in the dock — the panel under the editor — which is where VS Code
 * puts it, and it is opened the same way: by clicking the error and warning
 * counts at the left of the status bar.
 *
 * The list is bounded by what the language servers have told us about, which is
 * the files that are open. That is narrower than VS Code, whose TypeScript
 * extension can be asked to check the whole project, and it is stated in the
 * empty state rather than left for the user to work out.
 */
import { useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, CircleX, Info, Lightbulb } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore } from "@/stores/panel-store";
import { useProjectStore } from "@/stores/project-store";
import { useProblemsStore, filesForProject, problemCounts, problemKey, sortedProblems, type FileProblems } from "@/stores/problems-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { LspDiagnostic } from "@/hooks/use-lsp";
import { cn } from "@/lib/utils";

export function ProblemsPanel() {
  const allFiles = useProblemsStore(useShallow((s) => s.files));
  const activeProjectName = useProjectStore((s) => s.activeProject?.name ?? null);
  const isMobile = useIsMobile();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  const files = useMemo(() => filesForProject(allFiles, activeProjectName), [allFiles, activeProjectName]);

  const groups = useMemo(() => {
    const all = sortedProblems(files);
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    // Path, message and rule together, so "use-lsp", "not assignable" and the
    // `ts(2322)` the row displays all narrow the list. The code is a field of
    // its own and is not in the message, so matching only the message would
    // leave the most precise thing on screen unsearchable.
    return all
      .map((file) => ({
        ...file,
        diagnostics: file.filePath.toLowerCase().includes(needle)
          ? file.diagnostics
          : file.diagnostics.filter((d) => matches(d, needle)),
      }))
      .filter((file) => file.diagnostics.length > 0);
  }, [files, query]);

  const totals = useMemo(() => problemCounts(files), [files]);
  const shown = groups.reduce((sum, file) => sum + file.diagnostics.length, 0);

  function jump(file: FileProblems, diagnostic: LspDiagnostic) {
    const { grid, focusedPanelId, openTab } = usePanelStore.getState();
    // Clicking this panel's own tab focuses the dock, and `openTab` with no
    // target opens into the focused panel — which would put the editor inside
    // the dock, where `DOCK_ALLOWED_TAB_TYPES` does not even permit it. So the
    // target is named: the focused panel when it is one of the grid's, else the
    // first.
    const onGrid = grid.flat();
    const target = onGrid.includes(focusedPanelId) ? focusedPanelId : onGrid[0];

    openTab({
      type: "editor",
      title: file.filePath.split("/").pop() ?? file.filePath,
      // `lineNumber` is the metadata key PPM's tabs already reveal on, shared
      // with the search panel and chat's file:line links.
      metadata: {
        filePath: file.filePath,
        projectName: file.projectName,
        lineNumber: diagnostic.range.start.line + 1,
      },
      projectId: file.projectName,
      closable: true,
    }, target);
  }

  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (Object.keys(files).length === 0) {
    return (
      <div className="p-4 space-y-2">
        <p className="text-xs text-text-subtle">No problems have been detected in the open files.</p>
        <p className="text-[11px] text-text-subtle/70 leading-relaxed">
          Diagnostics come from the language server for each file you open, so a file that has
          never been opened is not checked.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 p-2 space-y-2 border-b border-border-soft">
        <div className="flex items-center gap-3 text-[11px] text-text-3">
          <span className="flex items-center gap-1">
            <CircleX className="size-3 text-error" />
            {totals.errors}
          </span>
          <span className="flex items-center gap-1">
            <AlertTriangle className="size-3 text-warning" />
            {totals.warnings}
          </span>
          <span className="ml-auto text-text-subtle">
            {groups.length} file{groups.length === 1 ? "" : "s"}
          </span>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter problems"
          className={cn(
            "w-full rounded border border-border bg-surface px-2 text-xs outline-none focus:border-primary",
            isMobile ? "min-h-11" : "py-1",
          )}
        />
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {shown === 0 && (
          <p className="p-4 text-xs text-text-subtle">No problems match “{query.trim()}”.</p>
        )}
        {groups.map((file) => {
          const key = problemKey(file.projectName, file.filePath);
          const isCollapsed = collapsed.has(key);
          return (
            <div key={key}>
              <button
                type="button"
                onClick={() => toggle(key)}
                className={cn(
                  "w-full flex items-center gap-1 px-2 text-left hover:bg-surface-elevated transition-colors",
                  isMobile ? "min-h-11" : "py-1",
                )}
              >
                {isCollapsed ? (
                  <ChevronRight className="size-3 shrink-0 text-text-subtle" />
                ) : (
                  <ChevronDown className="size-3 shrink-0 text-text-subtle" />
                )}
                <span className="text-xs truncate">{file.filePath.split("/").pop()}</span>
                <span className="text-[10px] text-text-subtle truncate min-w-0">
                  {dirOf(file.filePath)}
                </span>
                <span className="ml-auto shrink-0 rounded-full bg-surface-elevated px-1.5 text-[10px] text-text-3">
                  {file.diagnostics.length}
                </span>
              </button>

              {!isCollapsed &&
                file.diagnostics.map((diagnostic, index) => (
                  <button
                    key={`${diagnostic.range.start.line}:${diagnostic.range.start.character}:${index}`}
                    type="button"
                    onClick={() => jump(file, diagnostic)}
                    title={diagnostic.message}
                    className={cn(
                      "w-full flex items-start gap-1.5 pl-6 pr-2 text-left hover:bg-surface-elevated transition-colors",
                      isMobile ? "min-h-11 py-2" : "py-0.5",
                    )}
                  >
                    <SeverityIcon severity={diagnostic.severity} />
                    <span
                      className={cn(
                        "flex-1 min-w-0 text-xs text-text-2",
                        // One line on a pointer device to keep the list dense,
                        // wrapped on touch where there is no tooltip to fall
                        // back on for the rest of the message.
                        isMobile ? "break-words" : "truncate",
                      )}
                    >
                      {diagnostic.message}
                    </span>
                    <span className="shrink-0 text-[10px] text-text-subtle font-mono pt-px">
                      {sourceLabel(diagnostic)}
                      {diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}
                    </span>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function matches(diagnostic: LspDiagnostic, needle: string): boolean {
  return (
    diagnostic.message.toLowerCase().includes(needle) ||
    (diagnostic.source?.toLowerCase().includes(needle) ?? false) ||
    String(diagnostic.code ?? "").toLowerCase().includes(needle)
  );
}

function SeverityIcon({ severity }: { severity?: number }) {
  if (severity === 2) return <AlertTriangle className="size-3 shrink-0 text-warning mt-px" />;
  if (severity === 3) return <Info className="size-3 shrink-0 text-info mt-px" />;
  if (severity === 4) return <Lightbulb className="size-3 shrink-0 text-text-subtle mt-px" />;
  // Severity is optional in LSP and means "error" when absent.
  return <CircleX className="size-3 shrink-0 text-error mt-px" />;
}

/** `ts(2322) ` — the server and rule that produced it, as VS Code shows it. */
function sourceLabel(diagnostic: LspDiagnostic): string {
  if (!diagnostic.source) return "";
  return diagnostic.code === undefined
    ? `${diagnostic.source} `
    : `${diagnostic.source}(${diagnostic.code}) `;
}

function dirOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}
