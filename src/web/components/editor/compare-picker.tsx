import { useState, useMemo, useEffect, useRef } from "react";
import { Columns2, FileCode, X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTabStore } from "@/stores/tab-store";
import { useFileStore } from "@/stores/file-store";
import { useProjectStore } from "@/stores/project-store";
import { useCompareStore, type CompareSelection } from "@/stores/compare-store";
import { openCompareTab } from "@/lib/open-compare-tab";
import { basename, cn } from "@/lib/utils";
import { scoreFileSearch, compareScores } from "@/lib/score-file-search";

interface Candidate {
  id: string;
  path: string;
  label: string;
  source: "tab" | "file";
  dirtyContent?: string;
}

interface ComparePickerProps {
  /** Controlled mode: parent manages open state. Omit both to use singleton/event mode. */
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  /** If provided, dialog pre-seeds Side A. Ignored in singleton mode (reads from store on open). */
  initialA?: CompareSelection | null;
}

const MAX_RESULTS = 50;

/**
 * File-compare picker.
 *
 * Two modes:
 * - Controlled: pass `open`+`onOpenChange` (for tests / programmatic callers).
 * - Singleton: mount once at app root with no props — listens for
 *   `window` event `open-compare-picker` and seeds Side A from `useCompareStore`.
 */
export function ComparePicker({ open: openProp, onOpenChange, initialA }: ComparePickerProps = {}) {
  const controlled = openProp !== undefined;
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlled ? openProp : internalOpen;
  const setOpen = (o: boolean) => {
    if (controlled) onOpenChange?.(o);
    else setInternalOpen(o);
  };

  const [localA, setLocalA] = useState<CompareSelection | null>(initialA ?? null);

  // Singleton mode: listen for global event, seed A from store
  useEffect(() => {
    if (controlled) return;
    function onEvent() {
      setLocalA(useCompareStore.getState().selection);
      setInternalOpen(true);
    }
    window.addEventListener("open-compare-picker", onEvent);
    return () => window.removeEventListener("open-compare-picker", onEvent);
  }, [controlled]);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const tabs = useTabStore((s) => s.tabs);
  const fileIndex = useFileStore((s) => s.fileIndex);
  const activeProject = useProjectStore((s) => s.activeProject);

  useEffect(() => {
    if (!open) return;
    // In controlled mode, sync A from prop. In singleton mode, event handler
    // already populated localA — don't clobber it here.
    if (controlled) setLocalA(initialA ?? null);
    setQuery("");
    setActiveIndex(0);
    setError(null);
    // Focus input after dialog mounts
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open, initialA, controlled]);

  const candidates = useMemo<Candidate[]>(() => {
    const tabCands: Candidate[] = tabs
      .filter((t) => t.type === "editor" && t.metadata?.filePath)
      .map((t) => ({
        id: `tab:${t.id}`,
        path: t.metadata!.filePath as string,
        label: basename(t.metadata!.filePath as string),
        source: "tab",
        dirtyContent: t.metadata!.unsavedContent as string | undefined,
      }));
    const seenPaths = new Set(tabCands.map((c) => c.path));
    const fileCands: Candidate[] = fileIndex
      .filter((f) => f.type === "file" && !seenPaths.has(f.path))
      .map((f) => ({
        id: `file:${f.path}`,
        path: f.path,
        label: f.name,
        source: "file",
      }));
    return [...tabCands, ...fileCands];
  }, [tabs, fileIndex]);

  const filtered = useMemo<Candidate[]>(() => {
    if (!query.trim()) return candidates.slice(0, MAX_RESULTS);
    const scored = candidates
      .map((c) => {
        const score = scoreFileSearch(query, c.label, c.path);
        return score ? { c, score } : null;
      })
      .filter((x): x is { c: Candidate; score: ReturnType<typeof scoreFileSearch> & {} } => x !== null)
      .sort((a, b) => compareScores(a.score, b.score))
      .slice(0, MAX_RESULTS)
      .map((x) => x.c);
    return scored;
  }, [candidates, query]);

  useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(Math.max(0, filtered.length - 1));
  }, [filtered, activeIndex]);

  // Guards against rapid double-invoke (Enter spam, double-click) while the
  // openCompareTab promise is in flight — ref so a second sync call sees it.
  const pickingRef = useRef(false);

  async function handlePick(c: Candidate) {
    if (!activeProject) return;
    if (!localA) {
      setLocalA({
        filePath: c.path,
        projectName: activeProject.name,
        dirtyContent: c.dirtyContent,
        label: c.label,
      });
      setQuery("");
      setActiveIndex(0);
      inputRef.current?.focus();
      return;
    }
    if (pickingRef.current) return;
    pickingRef.current = true;
    try {
      await openCompareTab(
        { path: localA.filePath, dirtyContent: localA.dirtyContent },
        { path: c.path, dirtyContent: c.dirtyContent },
        activeProject.name,
      );
      useCompareStore.getState().clearSelection();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Compare failed");
    } finally {
      pickingRef.current = false;
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = filtered[activeIndex];
      if (pick) handlePick(pick);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Columns2 className="size-4" />
            Compare Files
          </DialogTitle>
        </DialogHeader>

        {/* Side A chip */}
        <div className="px-4 pb-2">
          {localA ? (
            <div className="flex items-center gap-2 text-xs bg-muted rounded px-2 py-1 w-fit max-w-full">
              <FileCode className="size-3.5 shrink-0" />
              <span className="truncate" title={localA.filePath}>{localA.label}</span>
              <button
                type="button"
                onClick={() => setLocalA(null)}
                className="hover:bg-surface-elevated rounded p-0.5"
                aria-label="Clear first file"
              >
                <X className="size-3" />
              </button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Pick first file, then second.</p>
          )}
        </div>

        {/* Search input */}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
          onKeyDown={handleKeyDown}
          placeholder={localA ? "Search for file B..." : "Search for file A..."}
          className="w-full px-4 py-2 bg-transparent border-y border-border text-sm outline-none"
        />

        {error && (
          <div className="px-4 py-2 text-xs text-destructive border-b border-border">{error}</div>
        )}

        {/* Results list */}
        <div className="max-h-[50vh] md:max-h-80 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              {candidates.length === 0 ? "No files available" : "No matches"}
            </div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                type="button"
                onClick={() => handlePick(c)}
                onMouseEnter={() => setActiveIndex(i)}
                className={cn(
                  "w-full flex items-center gap-2 px-4 py-1.5 text-left text-sm",
                  "hover:bg-surface-elevated transition-colors",
                  i === activeIndex && "bg-surface-elevated",
                )}
              >
                <FileCode className="size-3.5 shrink-0 text-text-secondary" />
                <span className="truncate">{c.label}</span>
                <span className="text-xs text-muted-foreground truncate ml-auto" title={c.path}>
                  {c.source === "tab" ? "open" : c.path}
                </span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
