/**
 * TreeDataProvider for database connections → tables → columns.
 * Fetches data from PPM REST API (/api/db/*).
 */

interface ConnectionNode {
  id: string;
  name: string;
  type: "connection" | "table" | "column";
  connectionId?: number;
  connectionName?: string;
  connectionType?: string;
  connectionColor?: string | null;
  schemaName?: string;
  dataType?: string;
}

interface ApiConnection {
  id: number;
  name: string;
  type: string;
  color: string | null;
}

interface ApiTable {
  name: string;
  schema: string;
  rowCount: number;
}

interface ApiColumn {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
  defaultValue: string | null;
}

export class ConnectionTreeProvider {
  private _onDidChange: { fire: (el?: ConnectionNode) => void; event: unknown };
  private baseUrl: string;

  constructor(eventEmitter: { fire: (el?: ConnectionNode) => void; event: unknown }, baseUrl = "") {
    this._onDidChange = eventEmitter;
    this.baseUrl = baseUrl;
  }

  get onDidChangeTreeData() {
    return this._onDidChange.event;
  }

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  async getChildren(element?: ConnectionNode): Promise<ConnectionNode[]> {
    if (!element) return this.getConnections();
    if (element.type === "connection") return this.getTables(element);
    if (element.type === "table") return this.getColumns(element);
    return [];
  }

  getTreeItem(element: ConnectionNode): Record<string, unknown> {
    const isConn = element.type === "connection";
    const isTable = element.type === "table";
    const isCol = element.type === "column";

    return {
      id: element.id,
      label: element.name,
      description: isCol ? element.dataType : undefined,
      collapsibleState: isCol ? "none" : "collapsed",
      contextValue: element.type,
      command: isTable ? "ppm-db.openViewer" : undefined,
      commandArgs: isTable
        ? [element.connectionId, element.connectionName ?? "Database", element.name, element.schemaName ?? "public"]
        : undefined,
      color: isConn ? (element.connectionColor ?? undefined) : undefined,
      badge: isConn ? (element.connectionType === "postgres" ? "PG" : "DB") : undefined,
      actions: isConn ? [
        { icon: "refresh", tooltip: "Refresh tables", command: "ppm-db.refreshConnection", commandArgs: [element.connectionId] },
      ] : undefined,
    };
  }

  private async getConnections(): Promise<ConnectionNode[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/db/connections`);
      const json = await res.json() as { ok: boolean; data?: ApiConnection[] };
      if (!json.ok || !json.data) return [];
      return json.data.map((c) => ({
        id: `conn:${c.id}`,
        name: c.name,
        type: "connection" as const,
        connectionId: c.id,
        connectionType: c.type,
        connectionColor: c.color,
      }));
    } catch {
      return [];
    }
  }

  private async getTables(conn: ConnectionNode): Promise<ConnectionNode[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/db/connections/${conn.connectionId}/tables`);
      const json = await res.json() as { ok: boolean; data?: ApiTable[] };
      if (!json.ok || !json.data) return [];
      return json.data.map((t) => ({
        id: `table:${conn.connectionId}:${t.schema}.${t.name}`,
        name: t.name,
        type: "table" as const,
        connectionId: conn.connectionId,
        connectionName: conn.name,
        connectionType: conn.connectionType,
        schemaName: t.schema,
      }));
    } catch {
      return [];
    }
  }

  private async getColumns(table: ConnectionNode): Promise<ConnectionNode[]> {
    try {
      const schema = table.schemaName ?? "public";
      const res = await fetch(
        `${this.baseUrl}/api/db/connections/${table.connectionId}/schema?table=${encodeURIComponent(table.name)}&schema=${schema}`,
      );
      const json = await res.json() as { ok: boolean; data?: ApiColumn[] };
      if (!json.ok || !json.data) return [];
      return json.data.map((c) => ({
        id: `col:${table.connectionId}:${table.name}.${c.name}`,
        name: c.name,
        type: "column" as const,
        connectionId: table.connectionId,
        dataType: c.type + (c.pk ? " PK" : ""),
      }));
    } catch {
      return [];
    }
  }
}
