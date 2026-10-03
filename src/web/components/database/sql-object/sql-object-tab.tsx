/**
 * DBGate's SQL object tab: one object's SQL, read-only — a table's CREATE TABLE, or its SELECT or
 * INSERT; a view's, a routine's, a trigger's or a sequence's own CREATE — and a button per script
 * that opens it in a new Query tab, where it can be edited and run.
 */
import { useState } from "react";
import Editor from "@monaco-editor/react";
import { ChevronDown, Code, FolderTree, SquareTerminal, Table } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { targetLabel, type DbScriptKind } from "@/lib/db-tabs";
import { EDITOR_FONT_FAMILY } from "@/lib/editor-font";
import { useMonacoTheme } from "@/lib/use-monaco-theme";
import { prepareMonacoTheme } from "@/theme/adapters/monaco-adapter";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTabStore } from "@/stores/tab-store";
import type { DbObjectKind, DbObjectScripts } from "../../../../shared/db-structure";
import { useDbTab } from "../use-db-tab";
import { useDbRead } from "../use-db-read";
import { openQueryTab, openStructureTab, openTableTab, type DbRelation } from "../explorer/open-db-tabs";
import { DbTabHeader, DbTabState, DbToolButton, DbToolbar } from "../db-tab-parts";
import { objectSqlPath, scriptChoices } from "./sql-object-model";

interface Props { metadata?: Record<string, unknown>; tabId?: string }

export function SqlObjectTab({ metadata, tabId }: Props) {
  const tab = useDbTab(metadata, tabId);
  const kind = metadata?.objectKind as DbObjectKind | undefined;
  const name = typeof metadata?.objectName === "string" ? metadata.objectName : "";
  const schemaName = typeof metadata?.schemaName === "string" ? metadata.schemaName : "";
  const args = typeof metadata?.objectArgs === "string" ? metadata.objectArgs : undefined;
  const owner = typeof metadata?.objectTable === "string" ? metadata.objectTable : undefined;
  const path = kind && name ? objectSqlPath({ kind, name, schema: schemaName || null, args, table: owner }) : null;
  const read = useDbRead<DbObjectScripts>(tab.missing ? null : tab.target, path, tabId);
  const scripts = read.data;
  // What the object is, once the server said: a name from the table cache may be a view.
  const actual = scripts?.kind ?? kind ?? "table";
  const choices = scriptChoices(actual, scripts);
  const [picked, setPicked] = useState<DbScriptKind>("create");
  const shown = choices.find((c) => c.kind === picked) ?? choices[0];
  const isRelation = actual === "table" || actual === "view" || actual === "matview";

  const rel: DbRelation = { schema: schemaName || null, name, kind: actual };
  const openStructure = () => { if (tab.place) openStructureTab(tab.place, rel); };
  const openData = () => { if (tab.place) openTableTab(tab.place, rel); };
  const openScript = (sql: string) => { if (tab.place) openQueryTab(tab.place, sql); };
  const close = tabId ? () => useTabStore.getState().closeTab(tabId) : undefined;

  if (tab.missing) return <DbTabState empty="This connection no longer exists." />;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <DbTabHeader
        title={name}
        subtitle={[targetLabel(tab.target, tab.name), schemaName, "SQL"].filter(Boolean).join(" · ")}
        color={tab.conn?.color ?? (metadata?.connectionColor as string | undefined)}
        onClose={close}
      />
      {/* On a phone its button is in the thumb zone, so an object with one script leaves it empty. */}
      <DbToolbar label={`${name} SQL`} className={cn(!isRelation && choices.length <= 1 && "max-md:hidden")}>
        {isRelation && (
          <>
            <DbToolButton icon={FolderTree} label="Structure" title={`Open the structure of ${name} in its own tab`} onClick={openStructure} opensTab disabled={!tab.place} />
            <DbToolButton icon={Table} label="Data" title={`Open the data of ${name}`} onClick={openData} opensTab disabled={!tab.place} />
          </>
        )}
        {choices.length > 1 && (
          <span className="relative mx-1 flex min-w-[150px] shrink-0 max-md:min-w-0 max-md:flex-1">
            <select
              aria-label="Script shown" value={shown?.kind} onChange={(e) => setPicked(e.target.value as DbScriptKind)}
              className="h-[26px] w-full min-w-0 appearance-none rounded-[5px] border border-border bg-input pr-[26px] pl-2 text-xs text-foreground outline-none focus:border-primary max-md:h-11 max-md:text-sm"
            >
              {choices.map((c) => <option key={c.kind} value={c.kind}>{c.label}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute top-1/2 right-1.5 size-3.5 -translate-y-1/2 text-text-subtle" />
          </span>
        )}
        {choices.map((c) => (
          <DbToolButton
            key={c.kind} icon={SquareTerminal} label={c.label} title="Open this script in a new Query tab"
            onClick={() => openScript(c.sql)} disabled={!tab.place} className="max-md:hidden"
          />
        ))}
      </DbToolbar>
      <div className="min-h-0 flex-1 overflow-hidden bg-input">
        {shown ? (
          <ReadOnlySql sql={shown.sql} />
        ) : (
          <DbTabState loading={read.loading || (!read.error && !read.driver)} error={read.error} driver={read.driver} />
        )}
      </div>
      {shown && (
        // Three buttons with one icon say nothing on a phone, so it keeps one, for the script shown —
        // down here, as the Query tab's Run is: in the toolbar it took the width that the script's
        // name needs, and "CREATE MATERIALIZED VIEW" was cut short at 390px.
        <div className="flex shrink-0 gap-2 border-t border-border bg-panel-2 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden">
          <button
            type="button" onClick={() => openScript(shown.sql)} disabled={!tab.place}
            className="flex h-11 flex-1 items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            <SquareTerminal className="size-4" />Open in a new Query tab
          </button>
        </div>
      )}
    </div>
  );
}

export function ReadOnlySql({ sql }: { sql: string }) {
  const theme = useMonacoTheme();
  const isMobile = useIsMobile();
  return (
    <Editor
      beforeMount={prepareMonacoTheme}
      height="100%"
      language="sql"
      theme={theme}
      value={sql}
      loading={<Code className="size-5 text-text-subtle" />}
      options={{
        readOnly: true,
        domReadOnly: true,
        fontFamily: EDITOR_FONT_FAMILY,
        fontSize: 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        // A phone cannot scroll sideways through a long constraint line one-handed.
        wordWrap: isMobile ? "on" : "off",
        renderLineHighlight: "none",
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        folding: false,
        padding: { top: 8, bottom: 8 },
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        fixedOverflowWidgets: true,
      }}
    />
  );
}
