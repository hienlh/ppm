/**
 * Where a Query tab runs: DBGate's connection and database boxes. Switching either rewrites the
 * tab's target in place — the tab is named by its query, not its connection, so it stays the same
 * tab. A database file has no choice to make; its box names the file. The database box lists a
 * server's databases once the sidebar has read them; until then it names the one in use.
 */
import { ChevronDown, Database } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { targetFields, type DbTarget } from "@/lib/db-tabs";
import { useTabStore } from "@/stores/tab-store";
import { useDbExplorer } from "../explorer/db-explorer-store";
import { isSingleDatabase, ownDatabase, visibleDatabases } from "../explorer/explorer-model";
import type { Connection } from "../use-connections";

const SELECT = "h-[26px] w-full min-w-0 appearance-none rounded-[5px] border border-border bg-input pr-[26px] pl-2 text-xs text-foreground outline-none focus:border-primary max-md:h-11 max-md:text-sm";

/** Everything a tab records about where it is, which a switch replaces as a whole. */
const PLACE_KEYS = ["connectionId", "database", "dbFile", "connectionName", "dbType", "connectionColor"];

export function QueryTargetPicker({ target, conn, fileName, metadata, tabId }: {
  target: DbTarget | null;
  conn: Connection | undefined;
  fileName: string;
  metadata: Record<string, unknown> | undefined;
  tabId: string | undefined;
}) {
  const connections = useDbExplorer((s) => s.connections);
  const databases = useDbExplorer((s) => (conn ? s.databases[conn.id] : undefined));

  if (target?.kind === "file") {
    return (
      <span className="flex min-w-0 shrink items-center gap-1.5 px-1 text-xs text-text-2 max-md:text-sm" title={target.path}>
        <Database className="size-4 shrink-0 text-text-subtle" />
        <span className="truncate">{fileName}</span>
      </span>
    );
  }

  const move = (next: DbTarget, c: Connection | undefined) => {
    if (!tabId) return;
    const rest = Object.fromEntries(Object.entries(metadata ?? {}).filter(([k]) => !PLACE_KEYS.includes(k)));
    useTabStore.getState().updateTab(tabId, {
      metadata: {
        ...rest, ...targetFields(next),
        ...(c ? { connectionName: c.name, dbType: c.type, ...(c.color ? { connectionColor: c.color } : {}) } : {}),
      },
    });
  };

  const own = conn ? ownDatabase(conn) : null;
  const current = target?.kind === "connection" ? target.database ?? own : null;
  const listed = conn && !isSingleDatabase(conn) && databases?.state === "ready" ? visibleDatabases(conn, databases.data) : null;
  // The one in use stays a choice even when the list hides it (or has not been read).
  const dbOptions = listed ? (current && !listed.includes(current) ? [current, ...listed] : listed) : current ? [current] : [];

  return (
    <>
      <Box className="w-[190px] max-md:w-auto max-md:flex-1" color={conn?.color}>
        <select
          aria-label="Connection" value={conn?.id ?? ""} className={cn(SELECT, conn?.color && "pl-6")}
          onChange={(e) => {
            const c = connections.find((x) => x.id === Number(e.target.value));
            if (c) move({ kind: "connection", connectionId: c.id }, c);
          }}
        >
          {!conn && <option value="">Connection…</option>}
          {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Box>
      {conn && !isSingleDatabase(conn) && dbOptions.length > 0 && (
        <Box className="w-[150px] max-md:w-auto max-md:flex-1">
          <select
            aria-label="Database" value={current ?? ""} className={SELECT}
            onChange={(e) => {
              const database = e.target.value;
              move({ kind: "connection", connectionId: conn.id, ...(database && database !== own ? { database } : {}) }, conn);
            }}
          >
            {dbOptions.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </Box>
      )}
    </>
  );
}

function Box({ children, className, color }: { children: React.ReactNode; className?: string; color?: string | null }) {
  return (
    <span className={cn("relative mx-0.5 flex shrink-0", className)}>
      {color && <span aria-hidden className="pointer-events-none absolute top-1/2 left-2 size-2 -translate-y-1/2 rounded-full" style={{ backgroundColor: color }} />}
      {children}
      <ChevronDown className="pointer-events-none absolute top-1/2 right-1.5 size-3.5 -translate-y-1/2 text-text-subtle" />
    </span>
  );
}
