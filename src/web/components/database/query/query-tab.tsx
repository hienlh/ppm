/**
 * DBGate's Query tab: SQL written against one connection — or one of its server's other databases,
 * or a database file — run as a script on one session, statement by statement, each statement's
 * rows in a result tab of its own beside Messages, with Stop for the statement running. The SQL is
 * kept in the tab as it is typed, so it survives a reload; a tab whose SQL differs from what it
 * opened with carries the unsaved dot. So do its row limit and Continue on error. Beside it on a
 * desktop, History lists what ran on the connection; a click puts that SQL in the editor. Ctrl+S
 * saves the SQL to a `.sql` file, asking where the first time; the tab is then named after the
 * file, and its dot says what differs from what the file holds.
 *
 * Keys, as DBGate has them: F5 runs the selection or else the whole script, Ctrl+Enter (and
 * Ctrl+Shift+Enter) the statement at the cursor, Shift+Alt+F formats the script. A phone has no
 * keys: its thumb bar has both runs.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { ArrowRightFromLine, ChevronDown, Gauge, GripHorizontal, History, IndentIncrease, MoreHorizontal, Play, Save, Square, TextSelect } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { targetLabel } from "@/lib/db-tabs";
import { formatCombo } from "@/stores/keybindings-store";
import { currentTabMetadata, patchTabMetadata } from "@/lib/patch-tab-metadata";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useAtMostWide } from "@/hooks/use-at-most-wide";
import { useTabStore } from "@/stores/tab-store";
import { unsavedGridRows } from "@/stores/unsaved-grid-rows-store";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { DEFAULT_QUERY_ROW_LIMIT, QUERY_ROW_LIMITS } from "../../../../shared/db-query-script";
import { isReadOnlyQuery } from "../../../../services/database/readonly-check";
import { useDbTab } from "../use-db-tab";
import { SqlQueryEditor, type SqlEditorHandle } from "../sql-query-editor";
import type { SqlRun } from "../sql-run";
import type { GridExport } from "../export-button";
import { DbTabHeader, DbTabState, DbToolButton, DbToolbar, toolButtonClass } from "../db-tab-parts";
import { gridExportForm } from "../impexp/impexp-state";
import { FLOATING_PANEL_TAB_WIDTH } from "../grid/table-view-state";
import { openImpExpTab } from "../impexp/open-impexp-tab";
import { useQueryRunner, type QueryRunRequest } from "./use-query-runner";
import { useSqlSchemaInfo } from "./use-sql-schema-info";
import { QueryTargetPicker } from "./query-target-picker";
import { resultOfTab, shownResultTab, stopTitle, type QueryResultTab, type QueryRunKind } from "./query-run-state";
import { ResultTabs } from "./result-tabs";
import { ResultView } from "./result-view";
import { DiscardResultEditsDialog } from "./discard-result-edits-dialog";
import { HistoryPanel } from "./history-panel";
import { queryFileTitle, savedFileOf, savedQueryTab } from "./query-file";
import { useQueryFileSave } from "./use-query-file-save";
import { formatSqlScript } from "./format-sql";

interface Props { metadata?: Record<string, unknown>; tabId?: string }

const MIN_EDITOR_H = 80;
/**
 * Labels give way as the room after the connection boxes narrows, so the buttons fit down to 485px
 * of it: the keys first (all of them take 1,103px), then every label but Current statement's and
 * Continue on error's (1,001px), then those two (703px). Measured in the browser; narrower still,
 * the toolbar scrolls.
 */
const KEYS_EARLY = "@max-[1120px]:hidden";
const LABEL_EARLY = "@max-[1020px]:hidden";
const LABEL_LATE = "@max-[720px]:hidden";

/** The tab's row limit, one of `QUERY_ROW_LIMITS`. */
function rowLimitOf(metadata: Record<string, unknown> | undefined): number {
  const n = metadata?.rowLimit;
  return typeof n === "number" && (QUERY_ROW_LIMITS as readonly number[]).includes(n) ? n : DEFAULT_QUERY_ROW_LIMIT;
}

const KIND_OF: Record<SqlRun["from"], QueryRunKind> = { script: "script", selection: "selection", statement: "statement" };

export function QueryTab({ metadata, tabId }: Props) {
  const tab = useDbTab(metadata, tabId);
  const isMobile = useIsMobile();
  const savedPath = savedFileOf(metadata);
  const title = savedPath ? queryFileTitle(savedPath)
    : typeof metadata?.queryNumber === "number" ? `Query ${metadata.queryNumber}` : "Query";
  const rowLimit = rowLimitOf(metadata);
  const continueOnError = metadata?.continueOnError === true;
  const runner = useQueryRunner(tab.target, { maxRows: rowLimit, continueOnError });
  const { run } = runner;

  // What the tab keeps — the SQL as typed and its run options — in its metadata (persisted with its own
  // debounce), over the metadata as the store has it now: a save may have written to it since this rendered.
  const updateTab = useTabStore((s) => s.updateTab);
  const metadataRef = useRef(metadata);
  metadataRef.current = metadata;
  const keep = useCallback((fields: Record<string, unknown>) => {
    if (tabId) patchTabMetadata(tabId, fields);
  }, [tabId]);
  const sqlRef = useRef(typeof metadata?.currentSql === "string" ? metadata.currentSql : "");
  const [initialSql] = useState(sqlRef.current);
  const onSqlChange = useCallback((sql: string) => {
    sqlRef.current = sql;
    keep({ currentSql: sql });
  }, [keep]);

  // Running again drops the results, and with them rows edited there and not saved: asked first.
  const [discardAsk, setDiscardAsk] = useState<QueryRunRequest | null>(null);
  const start = useCallback((request: QueryRunRequest) => {
    if (runner.running) return;
    if (tabId && unsavedGridRows(tabId) > 0) setDiscardAsk(request);
    else void runner.start(request);
  }, [runner.running, runner.start, tabId]); // eslint-disable-line react-hooks/exhaustive-deps
  const runSql = useCallback((r: SqlRun | null, kind?: QueryRunKind) => {
    if (r) start({ sql: r.sql, lineOffset: r.lineOffset, kind: kind ?? KIND_OF[r.from] });
  }, [start]);

  // SQL the app wrote to read something — a foreign key followed — runs once, on the way in.
  useEffect(() => {
    if (metadataRef.current?.runOnOpen !== true || !tab.target) return;
    const { runOnOpen: _, ...rest } = metadataRef.current;
    if (tabId) updateTab(tabId, { metadata: rest });
    void runner.start({ sql: sqlRef.current, lineOffset: 0, kind: "script" });
  }, [tab.target]); // eslint-disable-line react-hooks/exhaustive-deps

  const editor = useRef<SqlEditorHandle | null>(null);
  const schemaInfo = useSqlSchemaInfo(tab.target);
  const showLine = useCallback((line: number) => editor.current?.revealLine(line), []);

  // The result tab shown: Messages until a result comes, then the first — unless one was picked in this run.
  const [picked, setPicked] = useState<{ runId: string; key: string } | null>(null);
  const shown = shownResultTab(run, picked && run && picked.runId === run.runId ? picked.key : null);
  const pick = useCallback((key: string) => { if (run) setPicked({ runId: run.runId, key }); }, [run]);

  // Export advanced...: the Import/Export tab on the statement's query — only one that reads, which
  // running again for the file is safe; a phone has no such tab.
  const exportOf = useCallback((sql: string): (() => void) | undefined => {
    if (isMobile || !tab.target || !isReadOnlyQuery(sql, tab.dialect)) return undefined;
    const target = tab.target;
    return () => { openImpExpTab(gridExportForm({ target, schema: null }, "", sql)); };
  }, [isMobile, tab.target, tab.dialect]);
  const single = run?.done && run.kind !== "explain" && run.tabs.length === 1 ? resultOfTab(run, run.tabs[0]!) : null;
  const exportResult = single ? exportOf(single.result.sql) : undefined;

  const renderResult = useCallback((t: QueryResultTab) => {
    const found = run ? resultOfTab(run, t) : null;
    if (!run || !found) return null;
    const advanced = run.kind === "explain" ? undefined : exportOf(found.result.sql);
    const exporter: GridExport | undefined = advanced ? { busy: false, advanced } : undefined;
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
      if (!advanced || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "e") return;
      e.preventDefault();
      e.stopPropagation();
      advanced();
    };
    return (
      <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
        <ResultView
          tab={t} result={found.result} set={found.set} target={tab.target} readonly={tab.readonly} explain={run.kind === "explain"}
          connectionName={tab.name} dialect={tab.dialect} tabId={tabId} rereading={runner.rereading === t.key} exporter={exporter}
          onSave={(table, changes) => runner.saveChangesIn(t.key, table.table, table.schema, changes, tab.place)}
        />
      </div>
    );
  }, [run, exportOf, tab.target, tab.readonly, tab.name, tab.dialect, tab.place, tabId, runner.rereading, runner.saveChangesIn]);

  const [editorH, setEditorH] = useState(220);
  const bodyRef = useRef<HTMLDivElement>(null);
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = editorH;
    const max = (bodyRef.current?.clientHeight ?? 600) - 100;
    const move = (ev: PointerEvent) => setEditorH(Math.max(MIN_EDITOR_H, Math.min(startH + ev.clientY - startY, max)));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const [optionsOpen, setOptionsOpen] = useState(false);

  // Saved: named after the file from now on, over the metadata as it is once the file is written.
  const onFileSaved = useCallback((path: string, sql: string) => {
    if (tabId) updateTab(tabId, savedQueryTab(currentTabMetadata(tabId), path, sql));
  }, [tabId, updateTab]);
  const fileSave = useQueryFileSave({ tabId, keys: !isMobile, title, savedPath, sql: () => sqlRef.current, onSaved: onFileSaved });

  // History beside the editor unless put away — and in a narrow tab floating over it, put away to start with.
  const rootRef = useRef<HTMLDivElement>(null);
  const narrow = useAtMostWide(rootRef, FLOATING_PANEL_TAB_WIDTH);
  const [historyChoice, setHistoryChoice] = useState<boolean | null>(null);
  const historyOpen = !isMobile && !!tab.target && (historyChoice ?? !narrow);
  const pickFromHistory = useCallback((sql: string) => {
    editor.current?.insertText(sql);
    if (narrow) setHistoryChoice(false);
  }, [narrow]);

  if (tab.missing) return <DbTabState empty="This connection no longer exists." />;

  const where = targetLabel(tab.target, tab.name);
  const canRun = !!tab.target && !runner.running;
  const runScript = () => editor.current?.runScript();
  const runStatement = () => editor.current?.runAtCursor();
  const explain = () => runSql(editor.current?.selectionOrStatement() ?? null, "explain");
  const dbType = tab.dbType;
  const formatSql = () => {
    if (!dbType) return;
    try {
      editor.current?.reformat((sql) => formatSqlScript(sql, dbType));
    } catch (e) {
      toast.error("Could not format the SQL", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div ref={rootRef} className="flex h-full w-full flex-col overflow-hidden">
      <DbTabHeader title={title} subtitle={where} color={tab.conn?.color ?? (metadata?.connectionColor as string | undefined)}>
        <button
          type="button" onClick={() => setOptionsOpen(true)} aria-label="Run options"
          className="grid size-11 shrink-0 place-items-center rounded-md text-text-2"
        >
          <MoreHorizontal className="size-5" />
        </button>
      </DbTabHeader>
      <DbToolbar label={title}>
        <QueryTargetPicker target={tab.target} conn={tab.conn} fileName={tab.name} metadata={metadata} tabId={tabId} />
        {/* The buttons get what the connection's boxes leave them: a server's Database box is room they do not have. */}
        <div className="@container flex min-w-0 flex-1 items-center gap-0.5 max-md:gap-1">
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border max-md:hidden" />
          <button
            type="button" onClick={runScript} disabled={!canRun}
            title={`Run the whole script, or the selection (${formatCombo("F5")})`}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded bg-primary px-2.5 text-xs font-medium text-primary-foreground can-hover:hover:opacity-90 disabled:opacity-50 max-md:hidden"
          >
            <Play className="size-4" />Run
            <kbd className={cn("rounded bg-black/15 px-1 font-mono text-[10px]", KEYS_EARLY)}>F5</kbd>
          </button>
          <button
            type="button" onClick={runStatement} disabled={!canRun}
            title={`Run the statement at the cursor (${formatCombo("Mod+Enter")}, also ${formatCombo("Mod+Shift+Enter")})`}
            className={cn(toolButtonClass, "max-md:hidden")}
          >
            <TextSelect className="size-4 shrink-0" />
            <span className={LABEL_LATE}>Current statement</span>
            <kbd className={cn("rounded border border-border px-1 font-mono text-[10px] text-text-subtle", KEYS_EARLY)}>{formatCombo("Mod+Enter")}</kbd>
          </button>
          <DbToolButton
            icon={Square} label="Stop" title={stopTitle(tab.dialect)}
            onClick={() => void runner.stop()} disabled={!runner.running || runner.stopping}
            className="max-md:hidden" labelClassName={LABEL_EARLY}
          />
          <DbToolButton
            icon={Save} label="Save" onClick={fileSave.save} className="max-md:hidden" labelClassName={LABEL_EARLY}
            title={`${savedPath ? `Save the SQL to ${savedPath}` : "Save the SQL to a .sql file"} (${formatCombo("Mod+S")})`}
          />
          <DbToolButton
            icon={IndentIncrease} label="Format" title={`Format the SQL (${formatCombo("Shift+Alt+F")})`}
            onClick={formatSql} disabled={!dbType} className="max-md:hidden" labelClassName={LABEL_EARLY}
          />
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border max-md:hidden" />
          <DbToolButton
            icon={Gauge} label="Explain" title="EXPLAIN the selection, or the statement at the cursor — without ANALYZE, which would run it"
            onClick={explain} disabled={!canRun} className="max-md:hidden" labelClassName={LABEL_EARLY}
          />
          <label className={cn(toolButtonClass, "cursor-pointer max-md:hidden")} title="Go on with the statements after one that fails">
            <input
              type="checkbox" checked={continueOnError} onChange={(e) => keep({ continueOnError: e.target.checked })}
              className="size-3.5 accent-[var(--accent)]"
            />
            <span className={LABEL_LATE}>Continue on error</span>
          </label>
          <span className="flex-1" />
          <RowLimitSelect value={rowLimit} onChange={(n) => keep({ rowLimit: n })} className="max-md:hidden" />
          {!isMobile && (
            <DbToolButton
              icon={ArrowRightFromLine} label="Export result" opensTab onClick={() => exportResult?.()} disabled={!exportResult}
              title={exportResult ? "Export the result to a file, in the Import/Export tab" : "Export needs a run with one result, of a statement that only reads"}
              labelClassName={LABEL_EARLY} arrowClassName={LABEL_EARLY}
            />
          )}
          {!isMobile && (
            <button
              type="button" onClick={() => setHistoryChoice(!historyOpen)} aria-pressed={historyOpen} disabled={!tab.target}
              title="Query history: what was run on this connection" aria-label="History"
              className={cn(toolButtonClass, historyOpen && "bg-accent-wash text-primary can-hover:hover:bg-accent-wash can-hover:hover:text-primary")}
            >
              <History className="size-4 shrink-0" />
              <span className={LABEL_EARLY}>History</span>
            </button>
          )}
        </div>
      </DbToolbar>

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div ref={bodyRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className={cn("shrink-0", isMobile && "h-[38%]")} style={isMobile ? undefined : { height: editorH }}>
            <SqlQueryEditor
              onExecute={(r) => runSql(r)} loading={runner.running}
              defaultValue={initialSql} persistedSql={initialSql} onSqlChange={onSqlChange}
              schemaInfo={schemaInfo} dialect={tab.dialect} handleRef={editor}
              queryTab errorLines={run?.errorLines} onFormat={formatSql}
            />
          </div>
          <div
            role="separator" aria-orientation="horizontal" aria-label="Resize the editor"
            onPointerDown={startResize}
            className="flex h-1.5 shrink-0 cursor-row-resize touch-none items-center justify-center bg-border/50 can-hover:hover:bg-primary/30 max-md:hidden"
          >
            <GripHorizontal className="size-3 text-text-subtle/50" />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden border-t border-border md:border-t-0">
            {runner.driverMissing ? (
              <DbTabState driver={runner.driverMissing} />
            ) : run ? (
              <ResultTabs
                run={run} shown={shown} onPick={pick} onShowLine={showLine}
                onStop={() => void runner.stop()} stopping={runner.stopping} renderResult={renderResult}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center text-xs text-text-subtle">
                <span>Run a statement to see its result</span>
                <span className="max-md:hidden">
                  {formatCombo("F5")} runs the script or the selection · {formatCombo("Mod+Enter")} runs the statement at the cursor
                </span>
              </div>
            )}
          </div>
        </div>
        {historyOpen && tab.target && (
          <HistoryPanel
            target={tab.target} refreshKey={runner.ended} floating={narrow}
            onPick={pickFromHistory} onClose={() => setHistoryChoice(false)}
          />
        )}
      </div>

      {/* The thumb zone's runs on a phone, where F5 and Ctrl+Enter are not keys anyone has. */}
      <div className="flex shrink-0 gap-2 border-t border-border bg-panel-2 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden">
        {runner.running ? (
          <button
            type="button" onClick={() => void runner.stop()} disabled={runner.stopping}
            className="flex h-11 flex-1 items-center justify-center gap-2 rounded-md bg-destructive text-sm font-medium text-destructive-foreground disabled:opacity-60"
          >
            <Square className="size-4" />{runner.stopping ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <>
            <button
              type="button" onClick={runScript} disabled={!canRun}
              className="flex h-11 shrink-0 items-center justify-center gap-2 rounded-md border border-border px-3.5 text-sm text-text-2 disabled:opacity-50"
            >
              <Play className="size-4" />Whole script
            </button>
            <button
              type="button" onClick={runStatement} disabled={!canRun}
              className="flex h-11 flex-1 items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              <TextSelect className="size-4" />Run current statement
            </button>
          </>
        )}
      </div>

      <BottomSheet open={optionsOpen} onClose={() => setOptionsOpen(false)}>
        <div className="space-y-1 px-4 pb-4" role="dialog" aria-label="Run options">
          <h2 className="pb-2 text-base font-semibold">Run options</h2>
          <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
            Rows per result
            <RowLimitSelect value={rowLimit} onChange={(n) => keep({ rowLimit: n })} />
          </label>
          <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
            Continue on error
            <input
              type="checkbox" checked={continueOnError} onChange={(e) => keep({ continueOnError: e.target.checked })}
              className="size-5 accent-[var(--accent)]"
            />
          </label>
          <p className="text-xs text-text-subtle">A statement that fails stops the script, unless Continue on error is on.</p>
        </div>
      </BottomSheet>

      {discardAsk && (
        <DiscardResultEditsDialog
          onCancel={() => setDiscardAsk(null)}
          onDiscard={() => { const request = discardAsk; setDiscardAsk(null); void runner.start(request); }}
        />
      )}
      {fileSave.dialogs}
    </div>
  );
}

/** DBGate has no row limit; this one says how many rows each result keeps, the rest cut off and said so. */
function RowLimitSelect({ value, onChange, className }: { value: number; onChange: (n: number) => void; className?: string }) {
  const options = useMemo(() => QUERY_ROW_LIMITS.map((n) => ({ n, label: `≤ ${n.toLocaleString("en-US")} rows` })), []);
  return (
    <span className={cn("relative flex shrink-0", className)}>
      <select
        aria-label="Most rows per result" title="Most rows each result keeps" value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-[26px] appearance-none rounded-[5px] border border-border bg-input pr-[26px] pl-2 text-xs text-foreground outline-none focus:border-primary max-md:h-11 max-md:text-sm"
      >
        {options.map((o) => <option key={o.n} value={o.n}>{o.label}</option>)}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-1.5 size-3.5 -translate-y-1/2 text-text-subtle" />
    </span>
  );
}
