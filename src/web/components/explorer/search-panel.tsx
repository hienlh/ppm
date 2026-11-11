/**
 * The sidebar's Search panel, laid out like VS Code's Search view.
 *
 * Everything it shows lives in the search store (`src/web/stores/search-store.ts`), one entry per
 * project, so switching panels or closing the phone drawer loses nothing (6.5, 6.6). Requests go
 * through the search client (`src/web/lib/search/search-client.ts`); the panel only writes the
 * store and asks the client to search. Rows, counts, Collapse All and replace bodies come from the
 * pure model in `src/web/lib/search/search-rows.ts`.
 *
 * - Toolbar: Refresh, Clear Search Results, Collapse/Expand All, View as Tree/List (4.5, 4.6).
 * - The field holds Match Case / Whole Word / Regex (Alt+C/W/R while focus is in the panel, 3.5);
 *   the replace field holds Preserve Case (Alt+P) and Replace All (Ctrl+Alt+Enter), which asks
 *   first (`replace-all-dialog.tsx`).
 * - ··· folds include/exclude and "Use Exclude Settings and Ignore Files"; a dot on it says a
 *   filter applies (2.6).
 * - Banners for the result limit, the time limit, the grep fallback and errors with Retry (1.3,
 *   1.4, 7.5); an engine's regex error (HTTP 400) marks the field instead (3.2).
 * - Alt+↑/↓ (or ↑/↓ while the field is empty or a history walk is on) step through the project's
 *   history (6.3); ↓ otherwise moves into the results (6.1).
 * - Replace on one match or one file writes at once, drops the replaced rows and reports in the
 *   status line (5.4); a file with unsaved edits is never sent (5.8).
 *
 * On a phone (6.7) every button is a 44 px target, the options become chips under the field,
 * fields use 16 px text, and Replace All sits in the status line.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  EyeOff,
  FolderTree,
  Info,
  List,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Regex,
  ReplaceAll,
  Search,
  WholeWord,
  XCircle,
} from "@/lib/icons";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { defaultSearchState, useSearchStore, type SearchState } from "@/stores/search-store";
import { searchClient as defaultClient, type SearchClient } from "@/lib/search/search-client";
import {
  allCollapsibleIds,
  buildReplaceFiles,
  buildRows,
  countResults,
  filtersActive,
  matchKey,
  resultSummary,
  type ReplaceScope,
} from "@/lib/search/search-rows";
import { isFileUnsaved } from "@/lib/open-editors-registry";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { emitOnboardingEvidence } from "@/lib/onboarding/onboarding-types";
import { basename, cn } from "@/lib/utils";
import type { SearchMatch } from "../../../services/content-search/search-options";
import { SearchResults, type SearchResultsHandle } from "./search-results";
import { ReplaceAllDialog } from "./replace-all-dialog";

/** What a project nobody has searched shows; one object so the selector stays stable. */
const UNSEARCHED: SearchState = defaultSearchState();

type NoteTone = "success" | "warning" | "error";
interface Note { tone: NoteTone; text: string }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Alt+<key> toggles, by physical key: macOS turns Alt+C into "ç". */
const ALT_TOGGLES: Record<string, "caseSensitive" | "wholeWord" | "regex" | "preserveCase"> = {
  KeyC: "caseSensitive",
  KeyW: "wholeWord",
  KeyR: "regex",
  KeyP: "preserveCase",
};

export interface SearchPanelProps {
  /** Called after a match is opened (the phone drawer closes). */
  onNavigate?: () => void;
  /** The search client; tests pass a fake. */
  client?: SearchClient;
  /** Phone layout; defaults to the viewport breakpoint. */
  mobile?: boolean;
}

export function SearchPanel({ onNavigate, client = defaultClient, mobile: mobileProp }: SearchPanelProps = {}) {
  const activeProject = useProjectStore((s) => s.activeProject);
  const project = activeProject?.name ?? null;
  const st = useSearchStore((s) => (project ? s.projects[project] : undefined) ?? UNSEARCHED);
  const viewMode = useSearchStore((s) => s.viewMode);
  const viewportMobile = useIsMobile();
  const mobile = mobileProp ?? viewportMobile;

  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<SearchResultsHandle | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [replaceAllOpen, setReplaceAllOpen] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const replacedAll = useRef(false);

  const update = (patch: Partial<SearchState>) => {
    if (project) useSearchStore.getState().update(project, patch);
  };
  /** Change something the server's answer depends on, and search again after the debounce. */
  const change = (patch: Partial<SearchState>) => {
    if (!project) return;
    update(patch);
    setNote(null);
    client.schedule(project);
  };
  const searchNow = () => {
    if (!project) return;
    setNote(null);
    void client.searchNow(project);
  };

  useEffect(() => {
    if (project) client.warmUp(project);
    inputRef.current?.focus();
  }, [project, client]);

  // The onboarding tour's "search" step completes on a search answered while the panel is seen.
  const evidenceCount = useRef(0);
  const lastResponse = useRef(st.response);
  useEffect(() => {
    if (st.response === lastResponse.current) return;
    lastResponse.current = st.response;
    if (!project || !st.response || st.status !== "done") return;
    const visible = !!panelRef.current?.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true });
    if (visible) emitOnboardingEvidence({ type: "search-succeeded", projectName: project, requestId: String(++evidenceCount.current), visible });
  }, [st.response, st.status, project]);

  const rows = useMemo(
    () => buildRows(st.response, { viewMode, dismissed: st.dismissed, collapsed: st.collapsed }),
    [st.response, viewMode, st.dismissed, st.collapsed],
  );
  const counts = useMemo(() => countResults(st.response, st.dismissed), [st.response, st.dismissed]);
  const isUnsaved = (file: string) => !!project && isFileUnsaved(project, file);
  const fieldError = st.status === "error" && st.error?.status === 400 ? st.error.message : null;
  const bannerError = st.status === "error" && st.error && st.error.status !== 400 ? st.error : null;
  const canReplaceAll = st.showReplace && counts.total > 0 && !replacing;
  const anyCollapsed = st.collapsed.size > 0;

  function toggleOption(key: "caseSensitive" | "wholeWord" | "regex" | "preserveCase") {
    const patch = { [key]: !st[key] } as Partial<SearchState>;
    // Preserve Case only changes the server's replacements, which it computes only while replace is open.
    if (key === "preserveCase" && !st.showReplace) update(patch);
    else change(patch);
  }

  function openReplaceAll() {
    if (!canReplaceAll) return;
    replacedAll.current = false;
    setReplaceAllOpen(true);
  }

  function onPanelKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.altKey && (e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      openReplaceAll();
      return;
    }
    const toggle = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey ? ALT_TOGGLES[e.code] : undefined;
    if (toggle && project) {
      e.preventDefault();
      toggleOption(toggle);
    }
  }

  function step(direction: "older" | "newer") {
    if (!project) return;
    const before = useSearchStore.getState().projects[project]?.query;
    useSearchStore.getState().stepHistory(project, direction);
    if (useSearchStore.getState().projects[project]?.query !== before) {
      setNote(null);
      client.schedule(project);
    }
  }

  function onFieldKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    const walking = st.query === "" || st.historyIndex !== -1;
    if (e.key === "ArrowUp" && (e.altKey || walking)) {
      e.preventDefault();
      step("older");
    } else if (e.key === "ArrowDown" && (e.altKey || walking)) {
      e.preventDefault();
      step("newer");
    } else if (e.key === "ArrowDown" && rows.length > 0) {
      e.preventDefault();
      resultsRef.current?.focus();
    } else if (e.key === "Enter" && !e.altKey) {
      e.preventDefault();
      searchNow();
    }
  }

  function openMatch(file: string, match: SearchMatch) {
    if (!project) return;
    update({ focusedRow: matchKey(file, match) });
    // Match columns are 0-based; the editor's selection is 1-based, end exclusive (as Monaco counts).
    const column = match.column + 1;
    const metadata = {
      filePath: file,
      projectName: project,
      lineNumber: match.line,
      selection: { line: match.line, column, endColumn: column + match.length },
      revealAt: Date.now(),
    };
    const tabs = useTabStore.getState();
    const id = tabs.openTab({ type: "editor", title: basename(file), projectId: project, metadata, closable: true });
    // A tab already open on this file is deduped and keeps its old metadata: push the new target.
    if (id) tabs.updateTab(id, { metadata });
    onNavigate?.();
  }

  async function replaceScope(scope: ReplaceScope) {
    if (!project || replacing) return;
    const { files, unsaved } = buildReplaceFiles(st.response, st.dismissed, scope, isUnsaved);
    const unsavedNote = unsaved.length > 0
      ? `Skipped ${unsaved.join(", ")}: unsaved changes in an open tab.`
      : null;
    if (files.length === 0) {
      if (unsavedNote) setNote({ tone: "warning", text: unsavedNote });
      return;
    }
    setReplacing(true);
    try {
      const report = await client.replace(project, files);
      const notDone = new Set([...report.skipped, ...report.failed].map((f) => f.file));
      const dismissed = new Set(getStateOf(project).dismissed);
      for (const f of files) {
        if (notDone.has(f.file)) continue;
        for (const m of f.matches) dismissed.add(matchKey(f.file, m));
      }
      update({ dismissed });
      const parts: string[] = [];
      if (report.replaced > 0 || notDone.size === 0) {
        parts.push(`${plural(report.replaced, "replacement", "replacements")} made`);
      }
      if (unsavedNote) parts.push(unsavedNote);
      for (const s of report.skipped) parts.push(`Skipped ${s.file}: changed on disk since the search.`);
      for (const f of report.failed) parts.push(`Failed ${f.file}: ${f.reason}.`);
      const tone: NoteTone = report.failed.length > 0 ? "error" : notDone.size > 0 || unsavedNote ? "warning" : "success";
      setNote({ tone, text: parts.join(" ") });
    } catch (error) {
      setNote({ tone: "error", text: `Replace failed: ${(error as Error).message || "unknown error"}` });
    } finally {
      setReplacing(false);
    }
  }

  function copyPath(file: string) {
    const full = activeProject ? `${activeProject.path.replace(/\/$/, "")}/${file}` : file;
    void navigator.clipboard?.writeText(full).catch(() => {});
  }

  function toggleRow(id: string, collapsed: boolean) {
    const next = new Set(st.collapsed);
    if (collapsed) next.add(id);
    else next.delete(id);
    update({ collapsed: next });
  }

  const collapseAll = () => update({ collapsed: allCollapsibleIds(st.response, viewMode, st.dismissed) });
  const clear = () => {
    if (!project) return;
    client.cancel(project);
    useSearchStore.getState().clear(project);
    setNote(null);
    inputRef.current?.focus();
  };

  const btn = mobile ? "min-h-11 min-w-11" : "w-6 h-6";
  const fieldText = mobile ? "text-base" : "text-xs";

  const toolbar = (
    <div className={cn("flex items-center gap-0.5 border-b border-border px-2", mobile ? "h-12" : "h-8")}>
      <span className="flex-1 text-[10.5px] font-semibold uppercase tracking-wider text-text-secondary">Search</span>
      {!mobile && (
        <ToolButton label="Refresh" className={btn} onClick={searchNow} disabled={!project || st.query === ""}>
          <RefreshCw className="size-3.5" />
        </ToolButton>
      )}
      {mobile && (
        <DetailsToggle st={st} className={btn} onClick={() => update({ showDetails: !st.showDetails })} />
      )}
      <ToolButton label="Clear Search Results" className={btn} onClick={clear} disabled={!project}>
        <XCircle className="size-3.5" />
      </ToolButton>
      {!mobile && (
        <ToolButton
          label={anyCollapsed ? "Expand All" : "Collapse All"}
          className={btn}
          onClick={anyCollapsed ? () => update({ collapsed: new Set() }) : collapseAll}
          disabled={rows.length === 0 && !anyCollapsed}
        >
          {anyCollapsed ? <ChevronsUpDown className="size-3.5" /> : <ChevronsDownUp className="size-3.5" />}
        </ToolButton>
      )}
      <ToolButton
        label={viewMode === "list" ? "View as Tree" : "View as List"}
        className={btn}
        onClick={() => useSearchStore.getState().setViewMode(viewMode === "list" ? "tree" : "list")}
      >
        {viewMode === "list" ? <FolderTree className="size-3.5" /> : <List className="size-3.5" />}
      </ToolButton>
    </div>
  );

  const options = (
    <>
      <OptionButton label="Match Case" shortcut="Alt+C" active={st.caseSensitive} mobile={mobile} onClick={() => toggleOption("caseSensitive")}>
        <CaseSensitive className="size-3.5" />
      </OptionButton>
      <OptionButton label="Match Whole Word" shortcut="Alt+W" active={st.wholeWord} mobile={mobile} onClick={() => toggleOption("wholeWord")}>
        <WholeWord className="size-3.5" />
      </OptionButton>
      <OptionButton label="Use Regular Expression" shortcut="Alt+R" active={st.regex} mobile={mobile} onClick={() => toggleOption("regex")}>
        <Regex className="size-3.5" />
      </OptionButton>
    </>
  );

  const replaceToggle = (
    <button
      type="button"
      aria-label="Toggle Replace"
      title="Toggle Replace"
      aria-expanded={st.showReplace}
      disabled={!project}
      onClick={() => change({ showReplace: !st.showReplace })}
      className={cn(
        "flex shrink-0 items-center justify-center rounded text-text-subtle hover:text-foreground disabled:opacity-40",
        mobile ? "min-h-11 min-w-11 gap-1 border border-border px-2 text-sm" : "w-4 self-stretch",
        mobile && st.showReplace && "border-primary text-primary bg-primary/10",
      )}
    >
      {mobile ? "Replace" : st.showReplace ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
    </button>
  );

  return (
    <div ref={panelRef} data-onboarding="search" className="flex h-full flex-col" onKeyDown={onPanelKeyDown}>
      {toolbar}

      <div className="space-y-1.5 border-b border-border p-2">
        <div className="flex gap-1">
          {!mobile && replaceToggle}
          <div className="min-w-0 flex-1 space-y-1.5">
            {/* Search field, options inside on desktop */}
            <div
              className={cn(
                "flex items-center gap-0.5 rounded border bg-background pl-2 pr-0.5 focus-within:ring-1 focus-within:ring-primary/50",
                fieldError ? "border-destructive" : "border-border",
                mobile ? "min-h-11" : "h-[26px]",
              )}
            >
              <Search className="size-3.5 shrink-0 text-text-subtle" />
              <input
                ref={inputRef}
                aria-label="Search"
                aria-invalid={fieldError ? true : undefined}
                value={st.query}
                onChange={(e) => change({ query: e.target.value })}
                onKeyDown={onFieldKeyDown}
                placeholder={project ? "Search" : "Select a project first"}
                disabled={!project}
                spellCheck={false}
                className={cn("min-w-0 flex-1 bg-transparent px-1 py-1 outline-none disabled:opacity-50", fieldText)}
              />
              {!mobile && options}
            </div>
            {fieldError && (
              <p data-search-field-error="" className="text-[11px] leading-snug text-destructive">{fieldError}</p>
            )}
            {mobile && (
              <div className="flex flex-wrap items-center gap-1">
                {options}
                {replaceToggle}
              </div>
            )}

            {st.showReplace && (
              <div className="flex items-center gap-1">
                <div className={cn("flex min-w-0 flex-1 items-center gap-0.5 rounded border border-border bg-background pl-2 pr-0.5 focus-within:ring-1 focus-within:ring-primary/50", mobile ? "min-h-11" : "h-[26px]")}>
                  <input
                    aria-label="Replace"
                    value={st.replace}
                    onChange={(e) => change({ replace: e.target.value })}
                    placeholder="Replace"
                    disabled={!project}
                    spellCheck={false}
                    className={cn("min-w-0 flex-1 bg-transparent py-1 outline-none disabled:opacity-50", fieldText)}
                  />
                  <OptionButton label="Preserve Case" shortcut="Alt+P" active={st.preserveCase} mobile={mobile} onClick={() => toggleOption("preserveCase")}>
                    <span className="text-[10px] font-bold">AB</span>
                  </OptionButton>
                </div>
                {!mobile && (
                  <ToolButton label="Replace All" title="Replace All (Ctrl+Alt+Enter)" className="h-[26px] w-[26px]" onClick={openReplaceAll} disabled={!canReplaceAll}>
                    {replacing ? <Loader2 className="size-3.5 animate-spin" /> : <ReplaceAll className="size-3.5" />}
                  </ToolButton>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Below the chevron's rows, lined up with the fields (VS Code: the chevron spans search + replace only) */}
        {(!mobile || st.showDetails) && (
          <div className={cn("space-y-1.5", !mobile && "pl-5")}>
            {!mobile && (
              <div className="flex justify-end">
                <DetailsToggle st={st} className="h-[18px] w-[22px]" onClick={() => update({ showDetails: !st.showDetails })} />
              </div>
            )}

            {st.showDetails && (
              <div className="space-y-1.5">
                <FilterField label="Files to include" placeholder="e.g. *.ts, src/**/include" value={st.include} mobile={mobile} onChange={(v) => change({ include: v })} />
                <FilterField label="Files to exclude" placeholder="e.g. *.test.ts, **/fixtures/**" value={st.exclude} mobile={mobile} onChange={(v) => change({ exclude: v })}>
                  <OptionButton label="Use Exclude Settings and Ignore Files" active={st.useIgnore} mobile={mobile} onClick={() => change({ useIgnore: !st.useIgnore })}>
                    <EyeOff className="size-3.5" />
                  </OptionButton>
                </FilterField>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Status line: progress, count, the last single replace */}
      <div data-search-status="" className="flex min-h-[26px] flex-wrap items-center gap-x-1.5 px-3 py-1 text-[11px] text-text-secondary">
        {!project && <span>Select a project to search its files.</span>}
        {st.status === "searching" && (
          <span className="flex items-center gap-1"><Loader2 className="size-3 animate-spin" />Searching…</span>
        )}
        {st.status !== "searching" && st.response && <span className="tabular-nums">{resultSummary(counts)}</span>}
        {mobile && st.showReplace && st.status !== "searching" && counts.total > 0 && (
          <button type="button" className="min-h-11 text-primary underline disabled:opacity-40" disabled={!canReplaceAll} onClick={openReplaceAll}>
            · Replace All
          </button>
        )}
        {replacing && <span className="flex items-center gap-1"><Loader2 className="size-3 animate-spin" />Replacing…</span>}
        {note && (
          <span className={cn(note.tone === "success" && "text-success", note.tone === "warning" && "text-warning", note.tone === "error" && "text-destructive")}>
            {note.text}
          </span>
        )}
      </div>

      {st.response?.limitHit && (
        <Banner kind="limit" tone="warn">
          The result set only contains a subset of all matches. Be more specific in your search to narrow down the results.
        </Banner>
      )}
      {st.response?.incomplete === "timeout" && (
        <Banner kind="timeout" tone="warn" action={{ label: "Search again", onClick: searchNow }}>
          Search stopped after 30 s and may be incomplete. Narrow the files to include and
        </Banner>
      )}
      {st.response?.engine === "grep" && (
        <Banner kind="grep" tone="info">
          Searched with GNU grep: ripgrep is not installed here, so match columns and replacements are computed in PPM.
        </Banner>
      )}
      {st.response?.replaceUnavailable && st.showReplace && (
        <Banner kind="replace-unavailable" tone="warn">
          grep cannot compute replacements for this pattern. Install ripgrep to replace it.
        </Banner>
      )}
      {bannerError && (
        <Banner kind="error" tone="error" role="alert" action={{ label: "Retry", onClick: searchNow }}>
          {bannerError.status === 0 ? `Search failed: ${bannerError.message}` : bannerError.message}
        </Banner>
      )}

      <SearchResults
        ref={resultsRef}
        rows={rows}
        focusedRow={st.focusedRow}
        hasReplace={st.showReplace}
        mobile={mobile}
        onFocusRow={(id) => update({ focusedRow: id })}
        onToggle={toggleRow}
        onOpen={openMatch}
        onDismiss={(id) => update({ dismissed: new Set([...st.dismissed, id]) })}
        onReplace={(scope) => void replaceScope(scope)}
        onCopyPath={copyPath}
        onCollapseAll={collapseAll}
        onExitTop={() => inputRef.current?.focus()}
      />

      {replaceAllOpen && project && (
        <ReplaceAllDialog
          response={st.response}
          dismissed={st.dismissed}
          replaceText={st.replace}
          isUnsaved={isUnsaved}
          onReplace={async (files) => {
            const report = await client.replace(project, files);
            replacedAll.current = true;
            return report;
          }}
          onSearchAgain={() => { setReplaceAllOpen(false); searchNow(); }}
          onClose={() => {
            setReplaceAllOpen(false);
            // What was replaced is no longer what the list shows: read the project again.
            if (replacedAll.current) searchNow();
          }}
        />
      )}
    </div>
  );
}

function getStateOf(project: string): SearchState {
  return useSearchStore.getState().projects[project] ?? UNSEARCHED;
}

function ToolButton({
  label,
  title,
  expanded,
  className,
  onClick,
  disabled,
  children,
}: {
  label: string;
  title?: string;
  expanded?: boolean;
  className?: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      aria-expanded={expanded}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded text-text-secondary hover:bg-surface-hover hover:text-foreground disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

function OptionButton({
  label,
  shortcut,
  active,
  mobile,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  active: boolean;
  mobile: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={shortcut ? `${label} (${shortcut})` : label}
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center justify-center rounded border",
        mobile ? "min-h-11 min-w-11" : "h-5 w-5",
        active ? "border-primary/40 bg-primary/10 text-primary" : "border-transparent text-text-subtle hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function DetailsToggle({ st, className, onClick }: { st: SearchState; className: string; onClick: () => void }) {
  return (
    <ToolButton label="Toggle Search Details" expanded={st.showDetails} className={className} onClick={onClick}>
      <MoreHorizontal className="size-3.5" />
      {filtersActive(st) && (
        <span data-filter-dot="" className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary" />
      )}
    </ToolButton>
  );
}

function FilterField({
  label,
  placeholder,
  value,
  mobile,
  onChange,
  children,
}: {
  label: string;
  placeholder: string;
  value: string;
  mobile: boolean;
  onChange: (value: string) => void;
  children?: ReactNode;
}) {
  return (
    <label className="block space-y-0.5">
      <span className="px-0.5 text-[10.5px] text-text-subtle">{label.toLowerCase()}</span>
      <div className={cn("flex items-center gap-0.5 rounded border border-border bg-background pl-2 pr-0.5 focus-within:ring-1 focus-within:ring-primary/50", mobile ? "min-h-11" : "h-[26px]")}>
        <input
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          className={cn("min-w-0 flex-1 bg-transparent py-1 outline-none", mobile ? "text-base" : "text-xs")}
        />
        {children}
      </div>
    </label>
  );
}

function Banner({
  kind,
  tone,
  role,
  action,
  children,
}: {
  kind: string;
  tone: "warn" | "error" | "info";
  role?: "alert";
  action?: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  const Icon = tone === "error" ? AlertCircle : tone === "warn" ? AlertTriangle : Info;
  return (
    <div
      data-search-banner={kind}
      role={role}
      className={cn(
        "mx-2 mb-1.5 flex items-start gap-1.5 rounded border px-2 py-1.5 text-[11px] leading-snug",
        tone === "warn" && "border-warning/30 bg-warning/10",
        tone === "error" && "border-destructive/30 bg-destructive/10",
        tone === "info" && "border-primary/30 bg-primary/10",
      )}
    >
      <Icon className={cn("mt-px size-3.5 shrink-0", tone === "warn" && "text-warning", tone === "error" && "text-destructive", tone === "info" && "text-primary")} />
      <span className="min-w-0">
        {children}
        {action && (
          <>
            {" "}
            <button type="button" className="whitespace-nowrap text-primary underline" onClick={action.onClick}>
              {action.label}
            </button>
          </>
        )}
      </span>
    </div>
  );
}
