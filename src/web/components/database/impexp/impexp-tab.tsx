/**
 * DBGate's Import/Export tab: on the left the Source and Target configuration and the map of
 * tables or files to what they become, on the right the files the last run wrote, its messages
 * and, for an import, a preview of one file. Run starts a job on the server and the tab follows it;
 * while it runs the configuration is covered, as DBGate's is. The form is kept in the tab as it is
 * changed and the job's id beside it, so a reload shows the same form and follows the same job.
 * A phone is told to use a computer: the two columns and the map table need the width.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { GripVertical, Loader2, Play, Square } from "@/lib/icons";
import { targetUrl, type DbTarget } from "@/lib/db-tabs";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { usePanelStore } from "@/stores/panel-store";
import { useTabStore } from "@/stores/tab-store";
import type { ColumnMapEntry, ImpExpItemStatus, ImportUpload } from "../../../../shared/db-impexp";
import { DbTabState, DbToolButton, DbToolbar } from "../db-tab-parts";
import { refreshAfterStructureChange } from "../explorer/db-explorer-store";
import {
  addUploads, droppedUploads, exportRequest, impExpTitle, importRequest, isFileSource, itemsByRow, readImpExpForm,
  readJobRef, runBlocker, updateRow, type ImpExpForm, type ImpExpJobRef,
} from "./impexp-state";
import { useImpExpDatabase } from "./use-impexp-database";
import { useImpExpJob } from "./use-impexp-job";
import { deleteImpExpUpload } from "./impexp-upload";
import { ImpExpConfig } from "./impexp-config";
import { MapTable } from "./impexp-map-table";
import { ColumnsDialog } from "./impexp-columns-dialog";
import { MessagesPane, OutputFilesPane, PreviewPane } from "./impexp-side-panes";
import { ErrorDialog, SidePane } from "./impexp-parts";

interface Props { metadata?: Record<string, unknown>; tabId?: string }

/** The share of the width the configuration takes, and how far the splitter may move it. */
const DEFAULT_SPLIT = 0.7;
const MIN_SPLIT = 0.4;
const MAX_SPLIT = 0.85;
const SPLIT_STEP = 0.02;

/** The tab as the store holds it now: what `metadata` says may be a render behind. */
function storedTab(tabId: string) {
  for (const panel of Object.values(usePanelStore.getState().panels)) {
    const tab = panel.tabs.find((t) => t.id === tabId);
    if (tab) return tab;
  }
  return undefined;
}

export function ImpExpTab({ metadata, tabId }: Props) {
  const isMobile = useIsMobile();

  /** Writes `patch` over the tab's metadata as it stands; a key set to undefined is removed. */
  const patchMetadata = useCallback((patch: Record<string, unknown>) => {
    if (!tabId) return;
    const next: Record<string, unknown> = { ...(storedTab(tabId)?.metadata ?? {}), ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
    useTabStore.getState().updateTab(tabId, { metadata: next });
  }, [tabId]);

  const [form, setFormState] = useState<ImpExpForm>(() => readImpExpForm(metadata?.impexp));
  const formRef = useRef(form);
  const setForm = useCallback((change: (form: ImpExpForm) => ImpExpForm) => {
    const prev = formRef.current;
    const next = change(prev);
    if (next === prev) return;
    formRef.current = next;
    setFormState(next);
    // A file no row reads any more is let go of on the server at once, not an hour later.
    for (const id of droppedUploads(prev, next)) deleteImpExpUpload(id);
    patchMetadata({ impexp: next });
  }, [patchMetadata]);

  const ctx = useImpExpDatabase(form.db, tabId);
  const fileFormat = isFileSource(form.sourceType) ? form.sourceType : null;
  const importing = fileFormat !== null;

  const [jobRef, setJobRef] = useState<ImpExpJobRef | null>(() => readJobRef(metadata?.impexpJob));
  const onJob = useCallback((j: ImpExpJobRef | null) => {
    setJobRef(j);
    patchMetadata({ impexpJob: j ?? undefined });
  }, [patchMetadata]);
  const job = useImpExpJob(jobRef, onJob);
  const [preserveLogs, setPreserveLogs] = useState(false);

  // The title says what goes where, as DBGate's does: `customers->CSV(3)`.
  const title = impExpTitle(form, ctx.name);
  const naming = !!ctx.target && ctx.name === null; // the connections are still being read
  useEffect(() => {
    if (!tabId || naming || storedTab(tabId)?.title === title) return;
    useTabStore.getState().updateTab(tabId, { title });
  }, [tabId, title, naming]);

  // An import that ends — however it ends — may have created or filled tables the tree shows.
  const importedInto = useRef<DbTarget | null>(null);
  const state = job.status?.state;
  useEffect(() => {
    if (state === "running" || !importedInto.current) return;
    const target = importedInto.current;
    importedInto.current = null;
    void refreshAfterStructureChange(target);
  }, [state]);

  const onUploaded = useCallback((upload: ImportUpload) => {
    const next = addUploads(formRef.current, [upload]);
    // Not taken — the source is no longer a file, or the map is full — so not kept either.
    if (!next.rows.some((r) => r.upload?.id === upload.id)) deleteImpExpUpload(upload.id);
    setForm(() => next);
  }, [setForm]);

  const blocker = runBlocker(form, ctx.readonly);
  const run = () => {
    if (blocker || !ctx.target || job.busy) return;
    if (importing) {
      const { request, rows } = importRequest(form, ctx.schema);
      importedInto.current = ctx.target;
      void job.start(targetUrl(ctx.target, "/impexp/import"), request, "import", rows, preserveLogs);
    } else {
      const { request, rows } = exportRequest(form, ctx.schema, new Date());
      void job.start(targetUrl(ctx.target, "/impexp/export"), request, "export", rows, preserveLogs);
    }
  };

  // The Status column, once this form's kind of job has run.
  const items = useMemo(() => {
    const status = job.status;
    if (!status || !jobRef || status.id !== jobRef.id || jobRef.kind !== (importing ? "import" : "export")) return null;
    return itemsByRow(jobRef, status.items);
  }, [job.status, jobRef, importing]);

  const [preview, setPreview] = useState<string | null>(null);
  const previewRow = importing ? form.rows.find((r) => r.source === preview && r.upload) : undefined;
  const [columnsFor, setColumnsFor] = useState<string | null>(null);
  const columnsRow = columnsFor === null ? undefined : form.rows.find((r) => r.source === columnsFor);
  const [errorItem, setErrorItem] = useState<ImpExpItemStatus | null>(null);
  const [collapsed, setCollapsed] = useState({ files: false, messages: false, preview: false });
  const fold = (pane: keyof typeof collapsed) => setCollapsed((c) => ({ ...c, [pane]: !c[pane] }));

  const [split, setSplit] = useState(DEFAULT_SPLIT);
  const bodyRef = useRef<HTMLDivElement>(null);
  const clampSplit = (v: number) => Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, v));
  const startResize = (e: PointerEvent) => {
    e.preventDefault();
    const box = bodyRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const move = (ev: globalThis.PointerEvent) => setSplit(clampSplit((ev.clientX - box.left) / box.width));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const resizeByKey = (e: KeyboardEvent) => {
    const step = e.key === "ArrowLeft" ? -SPLIT_STEP : e.key === "ArrowRight" ? SPLIT_STEP : 0;
    if (e.key === "Home" || e.key === "End") setSplit(e.key === "Home" ? MIN_SPLIT : MAX_SPLIT);
    else if (step) setSplit((s) => clampSplit(s + step));
    else return;
    e.preventDefault();
  };

  if (isMobile) return <DbTabState empty="Import/Export needs a wider screen. Open this tab on a computer." />;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <DbToolbar label="Import/Export">
        {job.busy ? (
          <DbToolButton icon={Square} label="Stop" title="Stop the job: what is finished stays" onClick={job.stop} disabled={!job.status} />
        ) : (
          <DbToolButton icon={Play} label="Run" title={blocker ?? (importing ? "Run the import" : "Run the export")} onClick={run} disabled={!!blocker} />
        )}
      </DbToolbar>

      <div ref={bodyRef} className="flex min-h-0 flex-1 overflow-hidden">
        <div className="relative min-w-0 shrink-0" style={{ width: `${split * 100}%` }}>
          <div className="h-full overflow-y-auto" inert={job.busy || undefined}>
            <ImpExpConfig form={form} ctx={ctx} onForm={setForm} onUploaded={onUploaded} />
            <MapTable
              form={form} items={items} existingTables={ctx.relations.filter((r) => r.kind === "table").map((r) => r.name)}
              preview={previewRow ? previewRow.source : null} onPreview={setPreview}
              onForm={setForm} onColumns={setColumnsFor} onError={setErrorItem}
            />
          </div>
          {job.busy && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/70" role="status">
              <span className="flex items-center gap-2 rounded-md border border-border bg-panel px-3 py-2 text-xs text-text-primary shadow-sm">
                <Loader2 className="size-4 animate-spin" />Processing import/export ...
              </span>
            </div>
          )}
        </div>
        <div
          role="separator" aria-orientation="vertical" aria-label="Resize the configuration"
          aria-valuemin={MIN_SPLIT * 100} aria-valuemax={MAX_SPLIT * 100} aria-valuenow={Math.round(split * 100)}
          tabIndex={0} onPointerDown={startResize} onKeyDown={resizeByKey}
          className="flex w-1.5 shrink-0 cursor-col-resize touch-none items-center justify-center bg-border/50 can-hover:hover:bg-primary/30 focus-visible:bg-primary/30 focus-visible:outline-none"
        >
          <GripVertical className="size-3 text-text-subtle/50" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-l border-border">
          <SidePane title="Output files" collapsed={collapsed.files} onToggle={() => fold("files")} className="h-[20%] shrink-0">
            <OutputFilesPane files={job.status?.files ?? []} onDownload={job.download} />
          </SidePane>
          <SidePane title="Messages" collapsed={collapsed.messages} onToggle={() => fold("messages")} className="min-h-0 flex-1">
            <MessagesPane messages={job.messages} preserveLogs={preserveLogs} onPreserveLogs={setPreserveLogs} />
          </SidePane>
          {previewRow && fileFormat && (
            <SidePane title="Preview" collapsed={collapsed.preview} onToggle={() => fold("preview")} className="min-h-0 flex-1">
              <PreviewPane row={previewRow} format={fileFormat} options={form.importOptions} />
            </SidePane>
          )}
        </div>
      </div>

      {columnsRow && (
        <ColumnsDialog
          key={columnsRow.source} form={form} row={columnsRow} ctx={ctx} onClose={() => setColumnsFor(null)}
          onConfirm={(columns: ColumnMapEntry[] | undefined) => setForm((f) => updateRow(f, columnsRow.source, { columns }))}
        />
      )}
      {errorItem?.error && <ErrorDialog title="Error" message={errorItem.error} onClose={() => setErrorItem(null)} />}
    </div>
  );
}
