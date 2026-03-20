import { useState, useRef, useCallback, useEffect } from "react";
import { Search, CaseSensitive, ChevronRight, ChevronDown, FileText, X, Loader2, WholeWord, Regex, ReplaceAll } from "lucide-react";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { projectUrl, api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

interface SearchMatch {
  lineNum: number;
  content: string;
}

interface SearchResult {
  file: string;
  matches: SearchMatch[];
}

/** Build highlight regex from query + options */
function buildHighlightRegex(query: string, caseSensitive: boolean, wholeWord: boolean, useRegex: boolean): RegExp | null {
  if (!query) return null;
  try {
    let pattern = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (wholeWord) pattern = `\\b${pattern}\\b`;
    return new RegExp(`(${pattern})`, caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

function HighlightMatch({ text, re }: { text: string; re: RegExp | null }) {
  if (!re) return <span>{text}</span>;
  try {
    re.lastIndex = 0;
    const parts = text.split(re);
    re.lastIndex = 0;
    return (
      <span>
        {parts.map((p, i) => {
          re.lastIndex = 0;
          return re.test(p) ? <mark key={i} className="bg-yellow-300/40 text-foreground rounded-sm">{p}</mark> : p;
        })}
      </span>
    );
  } catch {
    return <span>{text}</span>;
  }
}

function OptionButton({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "flex items-center justify-center w-6 h-6 rounded border shrink-0",
        active ? "border-primary text-primary bg-primary/10" : "border-border text-text-subtle hover:text-foreground hover:border-border/80"
      )}
    >
      {children}
    </button>
  );
}

export function SearchPanel() {
  const { activeProject } = useProjectStore();
  const openTab = useTabStore((s) => s.openTab);

  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [regexError, setRegexError] = useState(false);
  const [filesFilter, setFilesFilter] = useState("");
  const [replace, setReplace] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [replaceCount, setReplaceCount] = useState<number | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(async (q: string, cs: boolean, ww: boolean, rx: boolean, ff: string) => {
    setRegexError(false);
    if (!activeProject || (!rx && q.length < 2) || (rx && q.length < 1)) {
      setResults([]);
      setTotal(0);
      return;
    }
    if (rx) {
      try { new RegExp(q); } catch { setRegexError(true); setResults([]); return; }
    }
    setLoading(true);
    try {
      const params = new URLSearchParams({ q, caseSensitive: String(cs), wholeWord: String(ww), regex: String(rx) });
      if (ff) params.set("include", ff);
      const data = await api.get<{ results: SearchResult[]; total: number }>(
        `${projectUrl(activeProject.name)}/files/search?${params}`
      );
      setResults(data.results);
      setTotal(data.total);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [activeProject]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(query, caseSensitive, wholeWord, useRegex, filesFilter), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, caseSensitive, wholeWord, useRegex, filesFilter, doSearch]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const highlightRe = buildHighlightRegex(query, caseSensitive, wholeWord, useRegex);

  function openFile(file: string, lineNum?: number) {
    if (!activeProject) return;
    const name = file.split("/").pop() ?? file;
    openTab({
      type: "editor",
      title: name,
      metadata: { filePath: file, projectName: activeProject.name, lineNumber: lineNum },
      projectId: activeProject.name,
      closable: true,
    });
  }

  function toggleCollapse(file: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(file) ? next.delete(file) : next.add(file);
      return next;
    });
  }

  async function doReplaceAll() {
    if (!activeProject || !query || results.length === 0 || replacing) return;
    setReplacing(true);
    setReplaceCount(null);
    let count = 0;
    try {
      for (const r of results) {
        const fileData = await api.get<{ content: string }>(
          `${projectUrl(activeProject.name)}/files/read?path=${encodeURIComponent(r.file)}`
        );
        const re = buildHighlightRegex(query, caseSensitive, wholeWord, useRegex);
        if (!re) continue;
        re.lastIndex = 0;
        const matches = fileData.content.match(re) ?? [];
        if (!matches.length) continue;
        count += matches.length;
        re.lastIndex = 0;
        const newContent = fileData.content.replace(re, replace);
        await api.put(`${projectUrl(activeProject.name)}/files/write`, { path: r.file, content: newContent });
      }
      setReplaceCount(count);
      doSearch(query, caseSensitive, wholeWord, useRegex, filesFilter);
    } catch {
      // ignore
    } finally {
      setReplacing(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Search input + options */}
      <div className="p-2 border-b border-border space-y-1.5">
        {/* Search row */}
        <div className="relative flex items-center gap-1">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-text-subtle pointer-events-none" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setReplaceCount(null); }}
              placeholder={activeProject ? "Search files…" : "Select a project first"}
              disabled={!activeProject}
              className={cn(
                "w-full pl-7 pr-6 py-1 text-xs bg-input border rounded focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50",
                regexError ? "border-destructive" : "border-border"
              )}
            />
            {query && (
              <button
                onClick={() => { setQuery(""); setResults([]); setTotal(0); setRegexError(false); setReplaceCount(null); }}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-subtle hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        </div>

        {/* Option toggles */}
        <div className="flex items-center gap-1">
          <OptionButton active={caseSensitive} onClick={() => setCaseSensitive((v) => !v)} title="Match Case (Alt+C)">
            <CaseSensitive className="size-3.5" />
          </OptionButton>
          <OptionButton active={wholeWord} onClick={() => { setWholeWord((v) => !v); if (useRegex) setUseRegex(false); }} title="Match Whole Word (Alt+W)">
            <WholeWord className="size-3.5" />
          </OptionButton>
          <OptionButton active={useRegex} onClick={() => { setUseRegex((v) => !v); if (wholeWord) setWholeWord(false); }} title="Use Regular Expression (Alt+R)">
            <Regex className="size-3.5" />
          </OptionButton>
          {regexError && <span className="text-[10px] text-destructive ml-1">Invalid regex</span>}
        </div>

        {/* Replace row */}
        <div className="flex items-center gap-1">
          <div className="relative flex-1">
            <input
              value={replace}
              onChange={(e) => setReplace(e.target.value)}
              placeholder="Replace…"
              disabled={!activeProject}
              className="w-full pl-2 pr-6 py-1 text-xs bg-input border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
            />
            {replace && (
              <button onClick={() => setReplace("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-subtle hover:text-foreground">
                <X className="size-3" />
              </button>
            )}
          </div>
          <button
            onClick={doReplaceAll}
            disabled={!query || results.length === 0 || replacing}
            title="Replace All"
            className="flex items-center justify-center w-6 h-6 rounded border border-border text-text-subtle hover:text-foreground hover:border-border/80 disabled:opacity-40 shrink-0"
          >
            {replacing ? <Loader2 className="size-3.5 animate-spin" /> : <ReplaceAll className="size-3.5" />}
          </button>
        </div>

        {/* Files filter row */}
        <div className="relative">
          <input
            value={filesFilter}
            onChange={(e) => setFilesFilter(e.target.value)}
            placeholder="Files to include (e.g. *.ts, src/**)"
            disabled={!activeProject}
            className="w-full pl-2 pr-6 py-1 text-xs bg-input border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
          />
          {filesFilter && (
            <button onClick={() => setFilesFilter("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-subtle hover:text-foreground">
              <X className="size-3" />
            </button>
          )}
        </div>

        {/* Status line */}
        <div className="text-[10px] text-text-subtle h-3">
          {(loading || replacing) && (
            <span className="flex items-center gap-1">
              <Loader2 className="size-2.5 animate-spin" />
              {replacing ? "Replacing…" : "Searching…"}
            </span>
          )}
          {!loading && !replacing && replaceCount !== null && (
            <span className="text-green-500">{replaceCount} replacement{replaceCount !== 1 ? "s" : ""} made</span>
          )}
          {!loading && !replacing && replaceCount === null && !regexError && query.length >= 2 && results.length === 0 && <span>No results</span>}
          {!loading && !replacing && replaceCount === null && total > 0 && (
            <span>{total} result{total !== 1 ? "s" : ""} in {results.length} file{results.length !== 1 ? "s" : ""}</span>
          )}
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {results.map((r) => {
          const isCollapsed = collapsed.has(r.file);
          const fileName = r.file.split("/").pop() ?? r.file;
          const dirPath = r.file.includes("/") ? r.file.slice(0, r.file.lastIndexOf("/")) : "";
          return (
            <div key={r.file}>
              <button
                onClick={() => toggleCollapse(r.file)}
                className="w-full flex items-center gap-1 px-2 py-1 hover:bg-muted/50 text-left"
              >
                {isCollapsed ? <ChevronRight className="size-3 shrink-0 text-text-subtle" /> : <ChevronDown className="size-3 shrink-0 text-text-subtle" />}
                <FileText className="size-3 shrink-0 text-text-subtle" />
                <span className="text-xs font-medium text-foreground truncate">{fileName}</span>
                <span className="text-[10px] text-text-subtle truncate flex-1 min-w-0 ml-1">{dirPath}</span>
                <span className="text-[10px] text-text-subtle shrink-0 ml-1 bg-muted px-1 rounded">{r.matches.length}</span>
              </button>

              {!isCollapsed && r.matches.map((m) => (
                <button
                  key={`${r.file}-${m.lineNum}`}
                  onClick={() => openFile(r.file, m.lineNum)}
                  className="w-full flex items-start gap-2 pl-7 pr-2 py-0.5 hover:bg-primary/10 text-left"
                >
                  <span className="text-[10px] text-text-subtle shrink-0 w-7 text-right pt-px">{m.lineNum}</span>
                  <span className="text-xs text-text-secondary truncate font-mono leading-4">
                    <HighlightMatch text={m.content.trimStart()} re={highlightRe} />
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
