import { useState, useEffect, useRef } from "react";
import { Loader2, FolderOpen } from "lucide-react";
import { useProjectStore } from "@/stores/project-store";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

interface SuggestedDir {
  path: string;
  name: string;
}

interface AddProjectFormProps {
  onSuccess: () => void;
  onCancel: () => void;
  /** Extra class for the submit button row */
  footerClassName?: string;
}

export function AddProjectForm({ onSuccess, onCancel, footerClassName }: AddProjectFormProps) {
  const { addProject } = useProjectStore();
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [suggestions, setSuggestions] = useState<SuggestedDir[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Fetch suggestions when path changes
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!path.trim()) { setSuggestions([]); setShowSuggestions(false); return; }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const results = await api.get<SuggestedDir[]>(`/api/projects/suggest-dirs?q=${encodeURIComponent(path)}`);
        setSuggestions(results ?? []);
        setShowSuggestions(true);
      } catch {
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, 250);
  }, [path]);

  // Close suggestions on outside click
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  function selectSuggestion(dir: SuggestedDir) {
    setPath(dir.path);
    if (!name) setName(dir.name);
    setShowSuggestions(false);
  }

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!path.trim()) { setError("Path is required"); return; }
    setError("");
    setSubmitting(true);
    try {
      await addProject(path.trim(), name.trim() || undefined);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add project");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      {/* Path input with suggestions */}
      <div ref={wrapperRef} className="relative">
        <label className="block text-xs font-medium text-foreground mb-1">Project path</label>
        <div className="relative flex items-center">
          <FolderOpen className="absolute left-2.5 size-3.5 text-text-subtle pointer-events-none" />
          <input
            type="text"
            value={path}
            onChange={(e) => { setPath(e.target.value); setError(""); }}
            onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
            placeholder="/path/to/project"
            className="w-full pl-8 pr-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            autoFocus
            autoComplete="off"
          />
          {loading && <Loader2 className="absolute right-2.5 size-3.5 text-text-subtle animate-spin" />}
        </div>

        {/* Suggestions dropdown */}
        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute top-full left-0 right-0 mt-1 z-10 bg-popover border border-border rounded-md shadow-md max-h-48 overflow-y-auto">
            {suggestions.map((dir) => (
              <button
                key={dir.path}
                type="button"
                onMouseDown={() => selectSuggestion(dir)}
                className="w-full flex flex-col items-start px-3 py-2 text-left hover:bg-accent/50 transition-colors"
              >
                <span className="text-sm font-medium truncate w-full">{dir.name}</span>
                <span className="text-xs text-text-subtle truncate w-full">{dir.path}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Optional name */}
      <div>
        <label className="block text-xs font-medium text-foreground mb-1">Display name <span className="text-muted-foreground">(optional)</span></label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-project"
          className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className={cn("flex justify-end gap-2 pt-1", footerClassName)}>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm text-text-secondary hover:text-foreground transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || !path.trim()}
          className="px-3 py-1.5 text-sm bg-primary text-white rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {submitting ? "Adding…" : "Add Project"}
        </button>
      </div>
    </form>
  );
}
