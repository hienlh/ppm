import { useState, useEffect } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { BrowseButton } from "@/components/ui/browse-button";
import { ConnectionColorPicker } from "./connection-color-picker";
import type { Connection, CreateConnectionData, UpdateConnectionData } from "./use-connections";

interface ConnectionFormDialogProps {
  open: boolean;
  onClose: () => void;
  /** If provided, dialog is in edit mode */
  connection?: Connection;
  onSave?: (data: CreateConnectionData) => Promise<void>;
  onUpdate?: (id: number, data: UpdateConnectionData) => Promise<void>;
  onTest: (id: number) => Promise<{ ok: boolean; error?: string }>;
  /** Test raw (unsaved) connection config — enables Test button in create mode */
  onTestRaw?: (type: "sqlite" | "postgres", config: { type: string; path?: string; connectionString?: string }) => Promise<{ ok: boolean; error?: string }>;
}

interface FormState {
  name: string;
  type: "sqlite" | "postgres";
  path: string;
  connectionString: string;
  groupName: string;
  color: string | null;
  readonly: boolean;
}

export function ConnectionFormDialog({
  open, onClose, connection, onSave, onUpdate, onTest, onTestRaw,
}: ConnectionFormDialogProps) {
  const isEdit = !!connection;
  const [form, setForm] = useState<FormState>({
    name: "", type: "postgres", path: "", connectionString: "", groupName: "", color: null, readonly: true,
  });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) { setTestResult(null); setError(null); return; }
    if (connection) {
      // connection_config is not exposed by the API — path/connectionString start empty in edit mode
      setForm({
        name: connection.name,
        type: connection.type,
        path: "",
        connectionString: "",
        groupName: connection.group_name ?? "",
        color: connection.color,
        readonly: connection.readonly === 1,
      });
    } else {
      setForm({ name: "", type: "postgres", path: "", connectionString: "", groupName: "", color: null, readonly: true });
    }
  }, [open, connection]);

  const set = (key: keyof FormState, value: unknown) => {
    setForm((f) => ({ ...f, [key]: value }));
    setTestResult(null);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      let result: { ok: boolean; error?: string };
      if (isEdit) {
        result = await onTest(connection!.id);
      } else if (onTestRaw) {
        const config = form.type === "postgres"
          ? { type: "postgres" as const, connectionString: form.connectionString }
          : { type: "sqlite" as const, path: form.path };
        result = await onTestRaw(form.type, config);
      } else {
        result = { ok: false, error: "Save connection first" };
      }
      setTestResult(result);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setError(null);
    if (!form.name.trim()) { setError("Name is required"); return; }

    setSaving(true);
    try {
      if (isEdit && onUpdate) {
        // Only send connectionConfig if user entered a new value (API doesn't return existing config)
        const hasNewConfig = form.type === "postgres" ? !!form.connectionString.trim() : !!form.path.trim();
        const config = hasNewConfig
          ? (form.type === "postgres"
            ? { type: "postgres" as const, connectionString: form.connectionString }
            : { type: "sqlite" as const, path: form.path })
          : undefined;
        await onUpdate(connection!.id, {
          name: form.name.trim(),
          ...(config !== undefined && { connectionConfig: config }),
          groupName: form.groupName.trim() || null,
          color: form.color,
          readonly: form.readonly ? 1 : 0,
        });
      } else if (onSave) {
        const config = form.type === "postgres"
          ? { type: "postgres" as const, connectionString: form.connectionString }
          : { type: "sqlite" as const, path: form.path };
        await onSave({
          type: form.type,
          name: form.name.trim(),
          connectionConfig: config,
          groupName: form.groupName.trim() || undefined,
          color: form.color ?? undefined,
        });
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Connection" : "Add Connection"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-1">
          {/* Name */}
          <div>
            <label className="text-xs font-medium text-text-secondary mb-1 block">Name *</label>
            <input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="my-database"
              className="w-full h-8 text-sm px-2.5 rounded-md border border-border bg-background focus:outline-none focus:border-primary"
            />
          </div>

          {/* Type */}
          <div>
            <label className="text-xs font-medium text-text-secondary mb-1 block">Type</label>
            <select
              value={form.type}
              onChange={(e) => set("type", e.target.value as "sqlite" | "postgres")}
              className="w-full h-8 text-sm px-2 rounded-md border border-border bg-background focus:outline-none focus:border-primary"
            >
              <option value="postgres">PostgreSQL</option>
              <option value="sqlite">SQLite</option>
            </select>
          </div>

          {/* Connection config */}
          {form.type === "postgres" ? (
            <div>
              <label className="text-xs font-medium text-text-secondary mb-1 block">Connection String *</label>
              <input
                type="password"
                value={form.connectionString}
                onChange={(e) => set("connectionString", e.target.value)}
                placeholder="postgresql://user:pass@host:5432/db"
                className="w-full h-8 text-sm px-2.5 rounded-md border border-border bg-background focus:outline-none focus:border-primary font-mono"
              />
            </div>
          ) : (
            <div>
              <label className="text-xs font-medium text-text-secondary mb-1 block">File Path *</label>
              <div className="flex gap-1.5 items-center">
                <input
                  value={form.path}
                  onChange={(e) => set("path", e.target.value)}
                  placeholder="/path/to/database.db"
                  className="flex-1 h-8 text-sm px-2.5 rounded-md border border-border bg-background focus:outline-none focus:border-primary font-mono"
                />
                <BrowseButton
                  mode="file"
                  accept={[".db", ".sqlite", ".sqlite3"]}
                  title="Browse for SQLite database"
                  onSelect={(path) => set("path", path)}
                />
              </div>
            </div>
          )}

          {/* Group */}
          <div>
            <label className="text-xs font-medium text-text-secondary mb-1 block">Group</label>
            <input
              value={form.groupName}
              onChange={(e) => set("groupName", e.target.value)}
              placeholder="Production"
              className="w-full h-8 text-sm px-2.5 rounded-md border border-border bg-background focus:outline-none focus:border-primary"
            />
          </div>

          {/* Color */}
          <div>
            <label className="text-xs font-medium text-text-secondary mb-1 block">Tab Color</label>
            <ConnectionColorPicker value={form.color} onChange={(c) => set("color", c)} />
          </div>

          {/* Readonly toggle (edit only) */}
          {isEdit && (
            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-xs font-medium">Readonly</p>
                <p className="text-[10px] text-text-subtle">Block non-SELECT queries (AI protection)</p>
              </div>
              <button
                type="button"
                onClick={() => set("readonly", !form.readonly)}
                className={`relative w-9 h-5 rounded-full transition-colors ${form.readonly ? "bg-primary" : "bg-border"}`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white transition-transform ${form.readonly ? "translate-x-4" : ""}`}
                />
              </button>
            </div>
          )}

          {/* Test result */}
          {testResult && (
            <p className={`text-xs ${testResult.ok ? "text-green-500" : "text-red-500"}`}>
              {testResult.ok ? "✓ Connection successful" : `✗ ${testResult.error}`}
            </p>
          )}

          {/* Error */}
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={handleTest} disabled={testing} className="mr-auto">
            {testing ? "Testing…" : "Test Connection"}
          </Button>
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
