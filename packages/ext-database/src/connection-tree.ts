/**
 * TreeDataProvider for database connections → tables → columns.
 * Fetches data from PPM REST API (/api/db/*).
 */

interface ConnectionNode {
  id: string;
  name: string;
  type: "connection" | "group" | "table" | "column";
  connectionId?: number;
  connectionName?: string;
  connectionType?: string;
  connectionColor?: string | null;
  connectionReadonly?: number;
  groupName?: string | null;
  schemaName?: string;
  dataType?: string;
  rowCount?: number;
  children?: ConnectionNode[];
}

interface ApiConnection {
  id: number;
  name: string;
  type: string;
  color: string | null;
  readonly: number;
  group_name: string | null;
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
    if (!element) return this.getRootNodes();
    if (element.type === "group") return element.children ?? [];
    if (element.type === "connection") return this.getTables(element);
    if (element.type === "table") return this.getColumns(element);
    return [];
  }

  getTreeItem(element: ConnectionNode): Record<string, unknown> {
    const isConn = element.type === "connection";
    const isGroup = element.type === "group";
    const isTable = element.type === "table";
    const isCol = element.type === "column";

    // Table description: row count
    let description: string | undefined;
    if (isCol) description = element.dataType;
    else if (isTable && element.rowCount !== undefined) description = `${element.rowCount.toLocaleString()} rows`;

    // Connection badge: type + readonly
    let badge: string | undefined;
    if (isConn) {
      badge = element.connectionType === "postgres" ? "PG" : "DB";
      if (element.connectionReadonly === 1) badge += " 🔒";
    }

    return {
      id: element.id,
      label: element.name,
      description,
      collapsibleState: isCol ? "none" : "collapsed",
      contextValue: element.type,
      command: isTable ? "ppm-db.openViewer" : undefined,
      commandArgs: isTable
        ? [element.connectionId, element.connectionName ?? "Database", element.name, element.schemaName ?? "public"]
        : undefined,
      color: isConn ? (element.connectionColor ?? undefined) : undefined,
      badge,
      actions: isConn ? [
        { icon: "refresh", tooltip: "Refresh tables", command: "ppm-db.refreshConnection", commandArgs: [element.connectionId] },
        { icon: "edit", tooltip: "Edit connection", command: "ppm-db.editConnection", commandArgs: [element.connectionId] },
        { icon: "trash", tooltip: "Delete connection", command: "ppm-db.deleteConnection", commandArgs: [element.connectionId, element.name] },
      ] : isGroup ? [] : undefined,
    };
  }

  /** Build root tree: group nodes wrapping connection nodes, or flat if no groups */
  private async getRootNodes(): Promise<ConnectionNode[]> {
    const connections = await this.getConnections();
    // Group by group_name
    const groups = new Map<string, ConnectionNode[]>();
    for (const conn of connections) {
      const key = conn.groupName ?? "__ungrouped__";
      const list = groups.get(key) ?? [];
      list.push(conn);
      groups.set(key, list);
    }
    // If only one group (ungrouped), return connections flat
    if (groups.size <= 1 && groups.has("__ungrouped__")) {
      return connections;
    }
    // Build group nodes
    const result: ConnectionNode[] = [];
    const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
      if (a === "__ungrouped__") return 1;
      if (b === "__ungrouped__") return -1;
      return a.localeCompare(b);
    });
    for (const key of sortedKeys) {
      const label = key === "__ungrouped__" ? "Ungrouped" : key;
      result.push({
        id: `group:${key}`,
        name: label,
        type: "group",
        children: groups.get(key) ?? [],
      });
    }
    return result;
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
        connectionReadonly: c.readonly,
        groupName: c.group_name,
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
        rowCount: t.rowCount,
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
