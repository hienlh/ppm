import { useState, useEffect, useRef, useCallback } from "react";
import { FolderGit2, Loader2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { Input } from "@/components/ui/input";

interface DirSuggestItem {
  path: string;
  name: string;
}

interface DirSuggestProps {
  value: string;
  onChange: (value: string) => void;
  onSelect?: (item: DirSuggestItem) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

export function DirSuggest({ value, onChange, onSelect, placeholder, autoFocus }: DirSuggestProps) {
  const [allDirs, setAllDirs] = useState<DirSuggestItem[]>([]);
  const [filtered, setFiltered] = useState<DirSuggestItem[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const fetchedRef = useRef(false);

  // Fetch all git dirs once on mount (cached server-side for 5 min)
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    setLoading(true);
    api
      .get<DirSuggestItem[]>("/api/projects/suggest-dirs")
      .then((items) => {
        setAllDirs(items);
        setFiltered(items.slice(0, 50));
        setShowSuggestions(items.length > 0);
      })
      .catch(() => setAllDirs([]))
      .finally(() => setLoading(false));
  }, []);

  // Filter locally when value changes
  useEffect(() => {
    if (allDirs.length === 0) return;
    const q = value.trim().toLowerCase();
    if (!q) {
      setFiltered(allDirs.slice(0, 50));
    } else {
      setFiltered(
        allDirs
          .filter((d) => d.path.toLowerCase().includes(q) || d.name.toLowerCase().includes(q))
          .slice(0, 50),
      );
    }
    setSelectedIndex(0);
  }, [value, allDirs]);

  // Scroll selected into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleSelect = useCallback(
    (item: DirSuggestItem) => {
      onChange(item.path);
      onSelect?.(item);
      setShowSuggestions(false);
    },
    [onChange, onSelect],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!showSuggestions || filtered.length === 0) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => (i < filtered.length - 1 ? i + 1 : 0));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => (i > 0 ? i - 1 : filtered.length - 1));
          break;
        case "Tab":
        case "Enter":
          if (filtered[selectedIndex]) {
            e.preventDefault();
            handleSelect(filtered[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          setShowSuggestions(false);
          break;
      }
    },
    [showSuggestions, filtered, selectedIndex, handleSelect],
  );

  return (
    <div className="relative">
      <div className="relative">
        <Input
          placeholder={placeholder ?? "/home/user/my-project"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => filtered.length > 0 && setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
          autoFocus={autoFocus}
        />
        {loading && (
          <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 size-4 text-text-subtle animate-spin" />
        )}
      </div>
      {showSuggestions && filtered.length > 0 && (
        <div className="absolute z-50 left-0 right-0 top-full mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-surface shadow-lg">
          <div ref={listRef} className="py-1">
            {filtered.map((item, i) => (
              <button
                key={item.path}
                type="button"
                className={`flex items-center gap-2 w-full px-3 py-1.5 text-left text-sm transition-colors ${
                  i === selectedIndex
                    ? "bg-primary/10 text-primary"
                    : "hover:bg-surface-hover text-text-primary"
                }`}
                onMouseEnter={() => setSelectedIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleSelect(item);
                }}
              >
                <FolderGit2 className="size-4 text-green-500 shrink-0" />
                <div className="min-w-0 flex-1 flex items-baseline gap-2">
                  <span className="font-medium">{item.name}</span>
                  <span className="text-xs text-text-subtle truncate">{item.path}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
