/**
 * DBGate's question, shown in place of the object list while the row picked under Connections is
 * not the current database: which database the list shows, and whether to switch to the picked
 * one (connecting it first), connect it, or go back to the current one. The list stays with the
 * current database until the user says otherwise, because it belongs to the active tab.
 */
import { ArrowLeftRight, Loader2, Plug } from "@/lib/icons";
import { DbEngineIcon } from "@/lib/file-icons";
import { Button } from "@/components/ui/button";
import {
  connectConnection, setCurrentDatabase, showCurrentDatabase, useDbExplorer,
} from "./explorer/db-explorer-store";
import { isSingleDatabase, singleDatabaseName, type DbRef, type TreeConnection } from "./explorer/explorer-model";
import { DriverMissingNotice } from "./driver-missing-notice";

/** The name a database goes by in the tree: its own, a SQLite file's, or its connection's when it has none. */
export function databaseLabel(conn: TreeConnection, ref: DbRef): string {
  return ref.database ?? (singleDatabaseName(conn) || conn.name);
}

const buttonClass = "w-full justify-center gap-1.5 min-h-[30px] max-md:min-h-11 max-md:text-sm";

export function FocusedDatabasePrompt({ focused, current }: { focused: DbRef; current: DbRef | null }) {
  const connections = useDbExplorer((s) => s.connections);
  const status = useDbExplorer((s) => s.status);
  const fc = connections.find((c) => c.id === focused.conn);
  if (!fc) return null;
  const cc = current ? connections.find((c) => c.id === current.conn) : undefined;
  const st = status[fc.id];
  const open = st?.state === "open";
  const target = focused.database !== null || isSingleDatabase(fc) ? databaseLabel(fc, focused) : null;
  const currentName = cc && current ? databaseLabel(cc, current) : null;

  return (
    <div role="region" aria-label="Current database" className="grid min-h-0 content-start gap-2 overflow-auto px-3 pt-2 pb-3.5 text-[12.5px] text-text-secondary max-md:px-3.5 max-md:text-[13.5px]">
      {cc && current ? (
        <>
          <div className="text-[11px] text-text-subtle">Current database</div>
          <div className="flex min-w-0 items-center gap-[7px] rounded-md border border-border-soft bg-panel-2 px-[9px] py-[7px]">
            <DbEngineIcon type={cc.type} className="size-4" />
            <b className="min-w-0 truncate text-foreground">{currentName}</b>
            <span className="ml-auto shrink-0 text-[11.5px] text-text-subtle">{cc.name}</span>
          </div>
        </>
      ) : (
        <div className="text-[11px] text-text-subtle">No current database</div>
      )}

      {st?.state === "error" && (
        <>
          <div className="text-[11px] text-text-subtle">Error connecting {fc.name}</div>
          {st.driver
            ? <DriverMissingNotice compact driver={st.driver} />
            : <div className="rounded-md bg-error/10 px-[9px] py-[7px] font-mono text-[11.5px] leading-[1.45] break-words text-error">{st.message}</div>}
        </>
      )}

      {st?.state === "connecting" ? (
        <Button size="sm" disabled className={buttonClass}>
          <Loader2 className="size-4 animate-spin" />Connecting to {fc.name}…
        </Button>
      ) : target !== null ? (
        <>
          <Button size="sm" className={buttonClass} onClick={() => void setCurrentDatabase(focused)}>
            <ArrowLeftRight className="size-4" />
            <span className="truncate">Switch to {currentName === target && current?.conn !== fc.id ? `${target} on ${fc.name}` : target}</span>
          </Button>
          {!open && <div className="text-[11.5px] text-text-subtle">{fc.name} is not connected yet — switching connects it first.</div>}
        </>
      ) : !open ? (
        <Button size="sm" className={buttonClass} onClick={() => void connectConnection(fc.id, { expand: true })}>
          <Plug className="size-4" /><span className="truncate">Connect to {fc.name}</span>
        </Button>
      ) : (
        <div className="text-[11.5px] text-text-subtle">{fc.name} is a server: pick one of its databases above.</div>
      )}

      {currentName && (
        <Button size="sm" variant="outline" className={buttonClass} onClick={showCurrentDatabase}>
          <span className="truncate">Show {currentName}</span>
        </Button>
      )}
    </div>
  );
}
