import { useState } from "react";
import { Plus } from "lucide-react";
import { useTabStore } from "@/stores/tab-store";
import { ConnectionList } from "./connection-list";
import { ConnectionFormDialog } from "./connection-form-dialog";
import { useConnections, type Connection, type CreateConnectionData, type UpdateConnectionData } from "./use-connections";

export function DatabaseSidebar() {
  const { connections, loading, cachedTables, createConnection, updateConnection, deleteConnection, testConnection, refreshTables } = useConnections();
  const openTab = useTabStore((s) => s.openTab);
  const [addOpen, setAddOpen] = useState(false);
  const [editConn, setEditConn] = useState<Connection | null>(null);

  const handleOpenTable = (conn: Connection, tableName: string, schemaName: string) => {
    openTab({
      type: "database",
      title: `${conn.name} · ${tableName}`,
      projectId: null,
      closable: true,
      metadata: { connectionId: conn.id, connectionName: conn.name, dbType: conn.type, tableName, schemaName, connectionColor: conn.color },
    });
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this connection?")) return;
    await deleteConnection(id);
  };

  const handleCreate = async (data: CreateConnectionData) => {
    const created = await createConnection(data);
    // Auto-refresh tables after creating (use return value to avoid stale closure)
    if (created) refreshTables(created.id).catch(() => {});
  };

  const handleUpdate = async (id: number, data: UpdateConnectionData) => {
    await updateConnection(id, data);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-[10px] font-semibold text-text-subtle uppercase tracking-wider">Database</span>
        <button
          onClick={() => setAddOpen(true)}
          className="flex items-center justify-center size-5 rounded hover:bg-surface-elevated transition-colors text-text-subtle hover:text-foreground"
          title="Add connection"
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      {/* Connection list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <p className="px-4 py-6 text-xs text-text-subtle text-center">Loading…</p>
        ) : (
          <ConnectionList
            connections={connections}
            cachedTables={cachedTables}
            onOpenTable={handleOpenTable}
            onRefreshTables={refreshTables}
            onEdit={setEditConn}
            onDelete={handleDelete}
          />
        )}
      </div>

      {/* Add dialog */}
      <ConnectionFormDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSave={handleCreate}
        onTest={() => Promise.resolve({ ok: false, error: "Save connection first" })}
      />

      {/* Edit dialog */}
      {editConn && (
        <ConnectionFormDialog
          open={!!editConn}
          onClose={() => setEditConn(null)}
          connection={editConn}
          onUpdate={handleUpdate}
          onTest={(id) => testConnection(id)}
        />
      )}
    </div>
  );
}
