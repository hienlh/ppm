import { useState, useEffect, useCallback } from "react";
import { Plus, Download, Trash2, Pencil, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getMcpServers, deleteMcpServer, importMcpServers,
  type McpServerEntry,
} from "@/lib/api-mcp";
import { McpServerDialog } from "./mcp-server-dialog";

export function McpSettingsSection() {
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServerEntry | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  const fetchServers = useCallback(async () => {
    try {
      const data = await getMcpServers();
      setServers(data);
    } catch (e) {
      console.error("Failed to load MCP servers:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchServers(); }, [fetchServers]);

  const handleDelete = async (name: string) => {
    try {
      await deleteMcpServer(name);
      setDeleteConfirm(null);
      fetchServers();
    } catch (e) {
      console.error("Failed to delete:", e);
    }
  };

  const handleImport = async () => {
    setImporting(true);
    setImportMsg(null);
    try {
      const result = await importMcpServers();
      setImportMsg(`Imported ${result.imported}, skipped ${result.skipped}`);
      fetchServers();
    } catch (e: any) {
      setImportMsg(e.message || "Import failed");
    } finally {
      setImporting(false);
    }
  };

  const handleDialogClose = (saved?: boolean) => {
    setDialogOpen(false);
    setEditingServer(null);
    if (saved) fetchServers();
  };

  const openAdd = () => { setEditingServer(null); setDialogOpen(true); };
  const openEdit = (s: McpServerEntry) => { setEditingServer(s); setDialogOpen(true); };

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {servers.length === 0 ? (
        <div className="text-center py-8 space-y-2">
          <Server className="size-8 mx-auto text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            No MCP servers configured. Add one or import from Claude Code.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {servers.map((s) => (
            <div key={s.name} className="rounded-lg border bg-card p-3 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium truncate flex-1">{s.name}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
                  {s.transport}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground truncate">
                {serverPreview(s)}
              </p>
              <div className="flex justify-end gap-1.5">
                {deleteConfirm === s.name ? (
                  <>
                    <span className="text-[11px] text-destructive self-center mr-1">Delete?</span>
                    <Button variant="destructive" size="sm" className="h-8 min-w-[44px] text-xs cursor-pointer" onClick={() => handleDelete(s.name)}>Yes</Button>
                    <Button variant="outline" size="sm" className="h-8 min-w-[44px] text-xs cursor-pointer" onClick={() => setDeleteConfirm(null)}>No</Button>
                  </>
                ) : (
                  <>
                    <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 cursor-pointer" onClick={() => openEdit(s)}>
                      <Pencil className="size-3" /> Edit
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-destructive hover:text-destructive cursor-pointer" onClick={() => setDeleteConfirm(s.name)}>
                      <Trash2 className="size-3" /> Delete
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Actions — thumb zone */}
      <div className="space-y-2 pt-1">
        <Button className="w-full h-10 text-xs gap-1.5 cursor-pointer" onClick={openAdd}>
          <Plus className="size-3.5" /> Add MCP Server
        </Button>
        <Button variant="outline" className="w-full h-10 text-xs gap-1.5 cursor-pointer" onClick={handleImport} disabled={importing}>
          <Download className="size-3.5" /> {importing ? "Importing..." : "Import from Claude Code"}
        </Button>
        {importMsg && <p className="text-[11px] text-muted-foreground text-center">{importMsg}</p>}
      </div>

      <McpServerDialog open={dialogOpen} onClose={handleDialogClose} editServer={editingServer} />
    </div>
  );
}

function serverPreview(s: McpServerEntry): string {
  const c = s.config;
  if (s.transport === "stdio" || !("url" in c)) {
    const stdio = c as { command?: string; args?: string[] };
    return [stdio.command, ...(stdio.args ?? [])].join(" ");
  }
  return (c as { url?: string }).url ?? "";
}
