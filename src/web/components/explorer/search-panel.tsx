import { useState, useRef, useCallback, useEffect } from "react";
import { Search, CaseSensitive, ChevronRight, ChevronDown, FileText, X, Loader2 } from "lucide-react";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { projectUrl } from "@/lib/api-client";
import { cn } from "@/lib/utils";

interface SearchMatch {
  lineNum: number;
  content: string;
}

interface SearchResult {
  file: string;
  matches: SearchMatch[];
}

/** Highlight matched text in a line */
function HighlightMatch({ text, query, caseSensitive }: { text: string; query: string; caseSensitive: boolean }) {
  if (!query) return <span>{text}</span>;
  try {
    const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, caseSensitive ? "g" : "gi");
    const parts = text.split(re);
    return (
      <span>
        {parts.map((p, i) =>
          re.test(p) ? <mark key={i} className="bg-yellow-300/40 text-foreground rounded-sm">{p}</mark> : p
        )}
      </span>
    );
  } catch {
    return <span>{text}</span>;
  }
}

export function SearchPanel() {
  const { activeProject } = useProjectStore();
  const openTab = useTabStore((s) => s.openTab);

  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(async (q: string, cs: boolean) => {
    if (!activeProject || q.length < 2) {
      setResults([]);
      setTotal(0);
      return;
    }
    setLoading(true);
    try {
      const url = `${projectUrl(activeProject.name)}/files/search?q=${encodeURIComponent(q)}&caseSensitive=${cs}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.ok) {
        setResults(json.data.results);
        setTotal(json.data.total);
      }
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [activeProject]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(query, caseSensitive), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, caseSensitive, doSearch]);

  // Auto-focus input when panel mounts
  useEffect(() => { inputRef.current?.focus(); }, []);

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

  return (
    <div className="flex flex-col h-full">
      {/* Search input */}
      <div className="p-2 border-b border-border space-y-1.5">
        <div className="relative flex items-center gap-1">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-text-subtle pointer-events-none" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={activeProject ? "Search files…" : "Select a project first"}
              disabled={!activeProject}
              className="w-full pl-7 pr-6 py-1 text-xs bg-input border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
            />
            {query && (
              <button onClick={() => { setQuery(""); setResults([]); setTotal(0); }} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-subtle hover:text-foreground">
                <X className="size-3" />
              </button>
            )}
          </div>
          <button
            onClick={() => setCaseSensitive((v) => !v)}
            title="Case sensitive"
            className={cn("flex items-center justify-center w-6 h-6 rounded text-xs border shrink-0", caseSensitive ? "border-primary text-primary bg-primary/10" : "border-border text-text-subtle hover:text-foreground")}
          >
            <CaseSensitive className="size-3.5" />
          </button>
        </div>

        {/* Status line */}
        <div className="text-[10px] text-text-subtle h-3">
          {loading && <span className="flex items-center gap-1"><Loader2 className="size-2.5 animate-spin" /> Searching…</span>}
          {!loading && query.length >= 2 && results.length === 0 && <span>No results</span>}
          {!loading && total > 0 && <span>{total} result{total !== 1 ? "s" : ""} in {results.length} file{results.length !== 1 ? "s" : ""}</span>}
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
              {/* File header */}
              <button
                onClick={() => toggleCollapse(r.file)}
                className="w-full flex items-center gap-1 px-2 py-1 hover:bg-muted/50 text-left"
              >
                {isCollapsed ? <ChevronRight className="size-3 shrink-0 text-text-subtle" /> : <ChevronDown className="size-3 shrink-0 text-text-subtle" />}
                <FileText className="size-3 shrink-0 text-text-subtle" />
                <span className="text-xs font-medium text-foreground truncate">{fileName}</span>
                <span className="text-[10px] text-text-subtle truncate flex-1 min-w-0">{dirPath}</span>
                <span className="text-[10px] text-text-subtle shrink-0 ml-1 bg-muted px-1 rounded">{r.matches.length}</span>
              </button>

              {/* Matches */}
              {!isCollapsed && r.matches.map((m) => (
                <button
                  key={`${r.file}-${m.lineNum}`}
                  onClick={() => openFile(r.file, m.lineNum)}
                  className="w-full flex items-start gap-2 pl-7 pr-2 py-0.5 hover:bg-primary/10 text-left group"
                >
                  <span className="text-[10px] text-text-subtle shrink-0 w-7 text-right pt-px">{m.lineNum}</span>
                  <span className="text-xs text-text-secondary truncate font-mono leading-4">
                    <HighlightMatch text={m.content.trimStart()} query={query} caseSensitive={caseSensitive} />
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
