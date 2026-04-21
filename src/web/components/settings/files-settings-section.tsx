/**
 * files-settings-section.tsx
 * Settings section for file filter configuration: filesExclude, searchExclude, useIgnoreFiles.
 * Supports global scope and per-project override (active project only — no dropdown).
 */

import { useState, useEffect, useRef } from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useProjectStore } from "@/stores/project-store";
import { useFileStore } from "@/stores/file-store";
import {
  getFilesSettings,
  updateFilesSettings,
  getProjectSettings,
  updateProjectSettings,
  type FileFilterSettings,
} from "@/lib/api-files-settings";
import { GlobListEditor } from "./glob-list-editor";

type Scope = "global" | "project";

/** Default values used when project override has no value for a field */
const DEFAULTS: FileFilterSettings = {
  filesExclude: [],
  searchExclude: [],
  useIgnoreFiles: true,
};

export function FilesSettingsSection() {
  const activeProject = useProjectStore((s) => s.activeProject);

  const [scope, setScope] = useState<Scope>("global");
  const [filesExclude, setFilesExclude] = useState<string[]>([]);
  const [searchExclude, setSearchExclude] = useState<string[]>([]);
  const [useIgnoreFiles, setUseIgnoreFiles] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Abort controller for stale fetch cleanup
  const abortRef = useRef<AbortController | null>(null);

  // Load settings when scope or activeProject changes
  useEffect(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setLoading(true);
    setError(null);

    const loadSettings = async () => {
      try {
        if (scope === "global") {
          const s = await getFilesSettings();
          if (ac.signal.aborted) return;
          setFilesExclude(s.filesExclude);
          setSearchExclude(s.searchExclude);
          setUseIgnoreFiles(s.useIgnoreFiles);
        } else {
          // Per-project: fetch project override; fill missing fields with defaults
          if (!activeProject) return;
          const ps = await getProjectSettings(activeProject.name);
          if (ac.signal.aborted) return;
          const f = ps.files ?? {};
          setFilesExclude(f.filesExclude ?? DEFAULTS.filesExclude);
          setSearchExclude(f.searchExclude ?? DEFAULTS.searchExclude);
          setUseIgnoreFiles(f.useIgnoreFiles ?? DEFAULTS.useIgnoreFiles);
        }
      } catch (e) {
        if (ac.signal.aborted) return;
        setError((e as Error).message);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    };

    loadSettings();
    return () => ac.abort();
  }, [scope, activeProject?.name]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const payload: FileFilterSettings = {
        filesExclude: filesExclude.filter((p) => p.trim() !== ""),
        searchExclude: searchExclude.filter((p) => p.trim() !== ""),
        useIgnoreFiles,
      };

      if (scope === "global") {
        await updateFilesSettings(payload);
      } else {
        if (!activeProject) throw new Error("No active project");
        await updateProjectSettings(activeProject.name, { files: payload });
      }

      // Trigger server-side cache invalidation + frontend index reload
      const store = useFileStore.getState();
      store.invalidateIndex();
      if (activeProject) {
        store.loadIndex(activeProject.name);
      }

      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const canSwitchToProject = !!activeProject;

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-medium text-muted-foreground">File Filters</h3>

      {/* Scope toggle */}
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => setScope("global")}
          className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
            scope === "global"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-accent"
          }`}
        >
          Global
        </button>
        <button
          type="button"
          onClick={() => canSwitchToProject && setScope("project")}
          disabled={!canSwitchToProject}
          title={!canSwitchToProject ? "Open a project to edit per-project overrides" : undefined}
          className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
            scope === "project"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-accent"
          }`}
        >
          {activeProject ? activeProject.name : "Per-project"}
        </button>
      </div>

      {scope === "project" && activeProject && (
        <p className="text-[11px] text-muted-foreground -mt-2">
          Overrides for <span className="font-medium">{activeProject.name}</span>.
          Leave empty to use global settings.
        </p>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading...</p>
      ) : (
        <>
          {/* Files Exclude */}
          <div className="space-y-1.5">
            <Label className="text-xs">Files to Exclude</Label>
            <p className="text-[11px] text-muted-foreground">
              Glob patterns hidden from the file tree and palette.
            </p>
            <GlobListEditor
              value={filesExclude}
              onChange={setFilesExclude}
              placeholder="e.g. **/*.log or node_modules/**"
              disabled={saving}
            />
          </div>

          <Separator />

          {/* Search Exclude */}
          <div className="space-y-1.5">
            <Label className="text-xs">Search to Exclude</Label>
            <p className="text-[11px] text-muted-foreground">
              Glob patterns excluded from file index / palette search.
            </p>
            <GlobListEditor
              value={searchExclude}
              onChange={setSearchExclude}
              placeholder="e.g. dist/** or **/*.min.js"
              disabled={saving}
            />
          </div>

          <Separator />

          {/* useIgnoreFiles toggle */}
          <div className="flex items-center justify-between gap-2">
            <div>
              <Label className="text-xs">Use .gitignore rules</Label>
              <p className="text-[11px] text-muted-foreground">
                Respect .gitignore when filtering the file tree and index.
              </p>
            </div>
            <Switch
              checked={useIgnoreFiles}
              onCheckedChange={setUseIgnoreFiles}
              disabled={saving}
            />
          </div>

          {/* Error */}
          {error && (
            <p className="text-[11px] text-destructive">{error}</p>
          )}

          {/* Save button */}
          <Button
            onClick={handleSave}
            disabled={saving || loading}
            size="sm"
            className="h-8 text-xs w-full cursor-pointer"
          >
            {saving ? "Saving..." : saved ? "Saved" : "Save"}
          </Button>
        </>
      )}
    </div>
  );
}
