import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, Pencil, Check, X, RotateCcw } from "lucide-react";
import { api, projectUrl } from "@/lib/api-client";
import type { ProjectTag } from "../../../types/chat";

interface TagSettingsSectionProps {
  projectName: string;
  onTagsChanged?: () => void;
}

export function TagSettingsSection({ projectName, onTagsChanged }: TagSettingsSectionProps) {
  const [tags, setTags] = useState<ProjectTag[]>([]);
  const [defaultTagId, setDefaultTagId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#22c55e");
  const [showAdd, setShowAdd] = useState(false);

  const baseUrl = `${projectUrl(projectName)}/tags`;

  const loadTags = useCallback(async () => {
    try {
      const data = await api.get<{ tags: ProjectTag[]; defaultTagId: number | null }>(baseUrl);
      setTags(data.tags);
      setDefaultTagId(data.defaultTagId);
    } catch { /* silent */ }
    setLoading(false);
  }, [baseUrl]);

  useEffect(() => { loadTags(); }, [loadTags]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      await api.post(baseUrl, { name: newName.trim(), color: newColor });
      setNewName("");
      setShowAdd(false);
      loadTags();
      onTagsChanged?.();
    } catch { /* silent */ }
  };

  const handleUpdate = async (id: number) => {
    try {
      await api.patch(`${baseUrl}/${id}`, { name: editName.trim() || undefined, color: editColor || undefined });
      setEditingId(null);
      loadTags();
      onTagsChanged?.();
    } catch { /* silent */ }
  };

  const handleDelete = async (id: number, name: string) => {
    if (!window.confirm(`Delete tag "${name}"? Sessions with this tag will become untagged.`)) return;
    try {
      await api.del(`${baseUrl}/${id}`);
      loadTags();
      onTagsChanged?.();
    } catch { /* silent */ }
  };

  const handleSetDefault = async (tagId: number) => {
    const newId = tagId === defaultTagId ? null : tagId;
    try {
      await api.patch(`${baseUrl}/default-tag`, { tagId: newId });
      setDefaultTagId(newId);
    } catch { /* silent */ }
  };

  const handleReset = async () => {
    try {
      await api.post(`${baseUrl}/reset`, {});
      loadTags();
      onTagsChanged?.();
    } catch { /* silent */ }
  };

  if (loading) return <p className="text-[11px] text-muted-foreground animate-pulse">Loading tags...</p>;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-muted-foreground">Session Tags</h3>
        <div className="flex items-center gap-1">
          <button onClick={handleReset} className="p-1 rounded text-text-subtle hover:text-text-secondary" title="Reset to defaults">
            <RotateCcw className="size-3" />
          </button>
          <button onClick={() => setShowAdd(!showAdd)} className="p-1 rounded text-primary hover:bg-primary/10" title="Add tag">
            <Plus className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="flex items-center gap-1.5 px-1">
          <input type="color" value={newColor} onChange={(e) => setNewColor(e.target.value)} className="size-6 rounded cursor-pointer border-0 p-0" />
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setShowAdd(false); }}
            placeholder="Tag name"
            className="flex-1 min-w-0 bg-surface-elevated text-[11px] text-text-primary px-2 py-1 rounded border border-border outline-none focus:border-primary"
            autoFocus
          />
          <button onClick={handleCreate} className="p-1 text-green-500 hover:text-green-400"><Check className="size-3.5" /></button>
          <button onClick={() => setShowAdd(false)} className="p-1 text-text-subtle hover:text-text-secondary"><X className="size-3.5" /></button>
        </div>
      )}

      {/* Tag list */}
      <div className="space-y-0.5">
        {tags.map((tag) => (
          <div key={tag.id} className="flex items-center gap-1.5 px-1 py-1 rounded hover:bg-surface-elevated group">
            {editingId === tag.id ? (
              <>
                <input type="color" value={editColor} onChange={(e) => setEditColor(e.target.value)} className="size-5 rounded cursor-pointer border-0 p-0" />
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleUpdate(tag.id); if (e.key === "Escape") setEditingId(null); }}
                  className="flex-1 min-w-0 bg-surface-elevated text-[11px] px-1.5 py-0.5 rounded border border-border outline-none focus:border-primary"
                  autoFocus
                />
                <button onClick={() => handleUpdate(tag.id)} className="p-0.5 text-green-500"><Check className="size-3" /></button>
                <button onClick={() => setEditingId(null)} className="p-0.5 text-text-subtle"><X className="size-3" /></button>
              </>
            ) : (
              <>
                <span className="size-3 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
                <span className="flex-1 text-[11px] text-text-primary truncate">{tag.name}</span>
                <button
                  onClick={() => handleSetDefault(tag.id)}
                  className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition-colors ${
                    tag.id === defaultTagId
                      ? "bg-primary/15 text-primary border border-primary/30"
                      : "text-text-subtle border border-transparent can-hover:opacity-0 can-hover:group-hover:opacity-100 hover:bg-surface-elevated hover:border-border"
                  }`}
                  title={tag.id === defaultTagId ? "Default tag (click to unset)" : "Set as default for new sessions"}
                >
                  {tag.id === defaultTagId ? "Default" : "Set default"}
                </button>
                <button
                  onClick={() => { setEditingId(tag.id); setEditName(tag.name); setEditColor(tag.color); }}
                  className="p-0.5 rounded text-text-subtle hover:text-text-secondary can-hover:opacity-0 can-hover:group-hover:opacity-100"
                >
                  <Pencil className="size-3" />
                </button>
                <button
                  onClick={() => handleDelete(tag.id, tag.name)}
                  className="p-0.5 rounded text-text-subtle hover:text-red-400 can-hover:opacity-0 can-hover:group-hover:opacity-100"
                >
                  <Trash2 className="size-3" />
                </button>
              </>
            )}
          </div>
        ))}
        {tags.length === 0 && (
          <p className="text-[11px] text-muted-foreground py-2 text-center">No tags. Click + to create one.</p>
        )}
      </div>
    </div>
  );
}
