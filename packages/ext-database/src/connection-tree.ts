/**
 * TreeDataProvider for database connections → tables → columns.
 * Fetches data from PPM REST API (/api/db/*).
 */

interface ConnectionNode {
  id: string;
  name: string;
  type: "connection" | "table" | "column";
  connectionId?: number;
  connectionType?: string;
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
  table_name: string;
  schema_name: string;
}

interface ApiColumn {
  column_name: string;
  data_type: string;
  is_nullable: string;
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

  getTreeItem(element: ConnectionNode): {
    id: string;
    label: string;
    description?: string;
    collapsibleState: "none" | "collapsed" | "expanded";
    command?: string;
    contextValue?: string;
  } {
    return {
      id: element.id,
      label: element.name,
      description: element.type === "column" ? element.dataType : undefined,
      collapsibleState: element.type === "column" ? "none" : "collapsed",
      contextValue: element.type,
      command: element.type === "table" ? "ppm-db.openViewer" : undefined,
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
        id: `table:${conn.connectionId}:${t.schema_name}.${t.table_name}`,
        name: t.table_name,
        type: "table" as const,
        connectionId: conn.connectionId,
        connectionType: conn.connectionType,
        schemaName: t.schema_name,
      }));
    } catch {
      return [];
    }
  }

  private async getColumns(table: ConnectionNode): Promise<ConnectionNode[]> {
    try {
      const schema = table.schemaName ?? "public";
      const res = await fetch(
        `${this.baseUrl}/api/db/connections/${table.connectionId}/tables/${schema}.${table.name}/columns`,
      );
      const json = await res.json() as { ok: boolean; data?: ApiColumn[] };
      if (!json.ok || !json.data) return [];
      return json.data.map((c) => ({
        id: `col:${table.connectionId}:${table.name}.${c.column_name}`,
        name: c.column_name,
        type: "column" as const,
        connectionId: table.connectionId,
        dataType: c.data_type,
      }));
    } catch {
      return [];
    }
  }
}
