import { useState, useEffect, useRef } from "react";
import { Loader2, FolderOpen } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore } from "@/stores/project-store";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { BrowseButton } from "@/components/ui/browse-button";

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
  const { addProject } = useProjectStore(useShallow((s) => ({ addProject: s.addProject })));

  // ── Tab state ──────────────────────────────────────────────────────────────
  const [tab, setTab] = useState<"local" | "clone">("local");

  // ── Local folder state ─────────────────────────────────────────────────────
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [suggestions, setSuggestions] = useState<SuggestedDir[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // ── Clone state ────────────────────────────────────────────────────────────
  const [gitUrl, setGitUrl] = useState("");
  const [cloneDir, setCloneDir] = useState("~/Projects");
  const [cloneName, setCloneName] = useState("");
  const [cloning, setCloning] = useState(false);

  // ── Shared ─────────────────────────────────────────────────────────────────
  const [error, setError] = useState("");

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Load last clone dir on mount
  useEffect(() => {
    api.get<{ dir: string | null }>("/api/projects/last-clone-dir")
      .then((res) => { if (res?.dir) setCloneDir(res.dir); })
      .catch(() => {});
  }, []);

  // Auto-parse repo name from Git URL
  useEffect(() => {
    if (!gitUrl.trim()) { setCloneName(""); return; }
    const match = gitUrl.match(/[/:]([^/:]+?)(?:\.git)?\s*$/);
    if (match?.[1]) setCloneName(match[1]);
  }, [gitUrl]);

  // Fetch suggestions when local path changes
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

  async function handleClone(e?: React.FormEvent) {
    e?.preventDefault();
    if (!gitUrl.trim()) { setError("Git URL is required"); return; }
    if (!cloneDir.trim()) { setError("Clone directory is required"); return; }
    setError("");
    setCloning(true);
    try {
      const result = await api.post<{ path: string; project: unknown }>(
        "/api/projects/git/clone",
        { url: gitUrl.trim(), targetDir: cloneDir.trim(), name: cloneName.trim() || undefined },
      );
      // Server already added project — refresh store and select it
      const { fetchProjects, setActiveProject } = useProjectStore.getState();
      await fetchProjects();
      const projects = useProjectStore.getState().projects;
      const newProj = projects.find((p) => p.path === result.path);
      if (newProj) setActiveProject(newProj);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Clone failed");
    } finally {
      setCloning(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border">
        {(["local", "clone"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => { setTab(t); setError(""); }}
            className={cn(
              "px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors",
              tab === t
                ? "border-primary text-foreground"
                : "border-transparent text-text-secondary hover:text-foreground",
            )}
          >
            {t === "local" ? "Local folder" : "Clone from Git"}
          </button>
        ))}
      </div>

      {tab === "local" ? (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          {/* Path input with suggestions */}
          <div ref={wrapperRef} className="relative">
            <label className="block text-xs font-medium text-foreground mb-1">Project path</label>
            <div className="flex gap-1.5 items-center">
              <div className="relative flex items-center flex-1">
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
              <BrowseButton
                mode="folder"
                onSelect={(selectedPath) => {
                  setPath(selectedPath);
                  if (!name) setName(selectedPath.split("/").pop() ?? "");
                  setError("");
                }}
              />
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
      ) : (
        <form onSubmit={handleClone} className="flex flex-col gap-3">
          {/* Git URL */}
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Git URL</label>
            <input
              type="text"
              value={gitUrl}
              onChange={(e) => { setGitUrl(e.target.value); setError(""); }}
              placeholder="https://github.com/user/repo.git"
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              autoFocus
              autoComplete="off"
            />
          </div>

          {/* Clone to directory */}
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">Clone to</label>
            <div className="flex gap-1.5 items-center">
              <input
                type="text"
                value={cloneDir}
                onChange={(e) => { setCloneDir(e.target.value); setError(""); }}
                placeholder="~/Projects"
                className="flex-1 px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <BrowseButton
                mode="folder"
                onSelect={(p) => { setCloneDir(p); setError(""); }}
              />
            </div>
          </div>

          {/* Repo name override */}
          <div>
            <label className="block text-xs font-medium text-foreground mb-1">
              Name <span className="text-muted-foreground">(auto-parsed from URL)</span>
            </label>
            <input
              type="text"
              value={cloneName}
              onChange={(e) => setCloneName(e.target.value)}
              placeholder="repo-name"
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
              disabled={cloning || !gitUrl.trim() || !cloneDir.trim()}
              className="px-3 py-1.5 text-sm bg-primary text-white rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {cloning ? <><Loader2 className="inline size-3.5 animate-spin mr-1.5" />Cloning…</> : "Clone & Add"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
