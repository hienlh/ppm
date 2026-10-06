/**
 * The database side of the tab, as DBGate draws it in either column: its Current DB button, then
 * the Server, Database and Schema boxes. Servers are listed by name; as the target of an import,
 * a connection that refuses writes is listed greyed, "(read only)", and cannot be picked (DBGate
 * leaves it out). A server's Database box lists what its Advanced tab lets be seen, and Schema is
 * there only where the engine has schemas to choose from — Postgres.
 */
import { useId, useMemo } from "react";
import { fileDisplayName, type DbTarget } from "@/lib/db-tabs";
import { useSettingsStore } from "@/stores/settings-store";
import { DriverMissingNotice } from "../driver-missing-notice";
import { Field, Help, SelectInput } from "../connection-form/form-controls";
import { useDbExplorer } from "../explorer/db-explorer-store";
import { isSingleDatabase, ownDatabase, tabDatabase } from "../explorer/explorer-model";
import type { ImpExpDatabase } from "./impexp-state";
import type { ImpExpDbContext } from "./use-impexp-database";
import { formButtonClass } from "./impexp-parts";

const NOT_SELECTED = "(not selected)";

/** DBGate's Current DB: the database the Database sidebar shows, when it shows one. */
export function CurrentDbButton({ importing, onPick }: { importing: boolean; onPick: (db: ImpExpDatabase) => void }) {
  const current = useSettingsStore((s) => s.dbExplorerView.current);
  const conn = useDbExplorer((s) => (current ? s.connections.find((c) => c.id === current.conn) : undefined));
  if (!current || !conn) return null;
  const refused = importing && conn.readonly === 1;
  const database = tabDatabase(current, conn);
  const where = current.database ? `${conn.name} / ${current.database}` : conn.name;
  return (
    <button
      type="button" disabled={refused} className={formButtonClass}
      title={refused ? `${conn.name} is read only: nothing can be imported into it` : where}
      onClick={() => onPick({ target: { kind: "connection", connectionId: conn.id, ...(database ? { database } : {}) }, schema: null })}
    >
      Current DB
    </button>
  );
}

export function DatabaseFields({ db, ctx, importing, showSchema, onChange }: {
  db: ImpExpDatabase;
  ctx: ImpExpDbContext;
  /** The target of an import: a read only connection cannot be picked. */
  importing: boolean;
  /** A Query source names its tables in its SQL, so DBGate asks it for no schema. */
  showSchema: boolean;
  onChange: (db: ImpExpDatabase) => void;
}) {
  const id = useId();
  const connections = useDbExplorer((s) => s.connections);
  const servers = useMemo(() => [...connections].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })), [connections]);
  const target = db.target;
  const conn = ctx.conn;

  const pickServer = (value: string) => {
    if (value === "file" || !value) return;
    onChange({ target: { kind: "connection", connectionId: Number(value) }, schema: null });
  };

  const own = conn ? ownDatabase(conn) : null;
  const current = target?.kind === "connection" ? target.database ?? own : null;
  const listed = ctx.databases?.data ?? null;
  // The one in use stays a choice even when the list hides it, or has not been read yet.
  const databases = listed ? (current && !listed.includes(current) ? [current, ...listed] : listed) : current ? [current] : [];
  const pickDatabase = (name: string) => {
    if (!conn) return;
    const database = name ? tabDatabase({ conn: conn.id, database: name }, conn) : undefined;
    const next: DbTarget = { kind: "connection", connectionId: conn.id, ...(database ? { database } : {}) };
    onChange({ target: next, schema: null });
  };

  const objects = ctx.objects;
  return (
    <>
      <Field label="Server" htmlFor={`${id}-server`}>
        <SelectInput
          id={`${id}-server`} value={target?.kind === "file" ? "file" : target ? String(target.connectionId) : ""}
          onChange={(e) => pickServer(e.target.value)}
        >
          {!target && <option value="">{NOT_SELECTED}</option>}
          {target?.kind === "file" && <option value="file">{fileDisplayName(target.path)}</option>}
          {servers.map((c) => {
            const refused = importing && c.readonly === 1;
            return <option key={c.id} value={c.id} disabled={refused}>{refused ? `${c.name} (read only)` : c.name}</option>;
          })}
        </SelectInput>
      </Field>
      {conn && !isSingleDatabase(conn) && (
        <Field label="Database" htmlFor={`${id}-database`} error={ctx.databases?.error}>
          <SelectInput id={`${id}-database`} value={current ?? ""} onChange={(e) => pickDatabase(e.target.value)}>
            {!current && <option value="">{NOT_SELECTED}</option>}
            {databases.map((d) => <option key={d} value={d}>{d}</option>)}
          </SelectInput>
        </Field>
      )}
      {showSchema && ctx.schemas.length > 0 && (
        <Field label="Schema" htmlFor={`${id}-schema`}>
          <SelectInput id={`${id}-schema`} value={ctx.schema ?? ""} onChange={(e) => onChange({ ...db, schema: e.target.value || null })}>
            {ctx.schemas.map((s) => <option key={s} value={s}>{s}</option>)}
          </SelectInput>
        </Field>
      )}
      {target && objects.driver && <DriverMissingNotice driver={objects.driver} />}
      {target && !objects.driver && objects.error && <Help line={{ tone: "bad", text: objects.error }} />}
    </>
  );
}
