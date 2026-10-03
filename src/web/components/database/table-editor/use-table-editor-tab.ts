/**
 * The Structure tab as DBGate's table editor: what it shows (the change not saved yet, else the
 * table as the database has it), whether it can be changed, and its commands — Save (also Ctrl+S
 * while the tab is in front), Reset changes, and the dialogs the toolbar, the sections and the
 * command palette open. Every change goes straight into the tab's metadata, so a reload keeps it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePanelStore } from "@/stores/panel-store";
import { useKeybindingsStore } from "@/stores/keybindings-store";
import { isStructureTabDirty, nextTableEdit, readTableEdit, resetTableEdit, withTableEdit } from "@/lib/db-table-edit";
import type { DbTableStructure } from "../../../../shared/db-structure";
import type { StructureChange } from "../../../../shared/db-structure-change";
import { modelFromStructure, type TableModel } from "../../../../shared/db-table-model";
import type { DbTabContext } from "../use-db-tab";
import { openStructureTabInPlaceOf } from "../explorer/open-db-tabs";
import { requestStructureChange, useStructureSave } from "./structure-save-store";
import { offerTableEditorCommands } from "./table-editor-commands";
import { withTableName } from "./table-editor-model";
import type { EditorDialogState, ModelChange } from "./table-editor";

export interface TableEditorTab {
  /** What the tab shows: the change not saved yet, else the table as it was read; null until read. */
  model: TableModel | null;
  /** The table is not created yet (New table). */
  isNew: boolean;
  /** Its fields can be changed: a table, on a desktop, through a connection that takes writes. */
  editable: boolean;
  /** Holds a change not saved yet. */
  dirty: boolean;
  /** Save does something: a change is pending, or the table is still to be created. */
  canSave: boolean;
  save: () => void;
  reset: () => void;
  change: ModelChange;
  dialog: EditorDialogState | null;
  openDialog: (dialog: EditorDialogState) => void;
  closeDialog: () => void;
}

function tabMetadata(tabId: string): Record<string, unknown> | undefined {
  return usePanelStore.getState().getPanelForTab(tabId)?.tabs.find((t) => t.id === tabId)?.metadata;
}

/** The tab is the one in front of the focused panel: Ctrl+S and the palette are its. */
function inFront(tabId: string): boolean {
  const s = usePanelStore.getState();
  return s.panels[s.focusedPanelId]?.activeTabId === tabId;
}

export function useTableEditorTab({ tabId, metadata, tab, live, reload, mobile }: {
  tabId: string | undefined;
  metadata: Record<string, unknown> | undefined;
  tab: DbTabContext;
  live: DbTableStructure | null;
  reload: () => Promise<void>;
  mobile: boolean;
}): TableEditorTab {
  const dialect = tab.dialect ?? "postgres";
  const edit = useMemo(() => readTableEdit(metadata), [metadata]);
  const isNew = edit?.isNew === true;
  const liveModel = useMemo(() => (live ? modelFromStructure(live, dialect) : null), [live, dialect]);
  const model = edit?.current ?? liveModel;
  // The connection's own row says whether it takes writes, so nothing is editable before the list is read.
  const known = tab.target?.kind === "file" || !!tab.conn;
  const editable = !!tabId && !mobile && known && !tab.readonly && (isNew || live?.kind === "table");
  const dirty = isStructureTabDirty(metadata);
  const canSave = editable && (isNew || dirty);
  const [dialog, setDialog] = useState<EditorDialogState | null>(null);

  const liveRef = useRef(live);
  liveRef.current = live;

  const change: ModelChange = useCallback((fn) => {
    if (!tabId) return;
    const latest = tabMetadata(tabId);
    const next = nextTableEdit(readTableEdit(latest), liveRef.current, dialect, fn);
    usePanelStore.getState().updateTab(tabId, { metadata: withTableEdit(latest, next) });
  }, [tabId, dialect]);

  const clearEdit = useCallback(() => {
    if (!tabId) return;
    const latest = tabMetadata(tabId);
    usePanelStore.getState().updateTab(tabId, { metadata: withTableEdit(latest, null) });
  }, [tabId]);

  const reset = useCallback(() => {
    if (!tabId) return;
    const latest = tabMetadata(tabId);
    usePanelStore.getState().updateTab(tabId, { metadata: withTableEdit(latest, resetTableEdit(readTableEdit(latest))) });
  }, [tabId]);

  const save = () => {
    if (!canSave || !tabId || !tab.target || !tab.place || !edit) return;
    const place = tab.place;
    // Spaces typed around a new table's name are not part of it, as with a new column's.
    const created = isNew ? withTableName(edit.current, { name: edit.current.name.trim() }) : edit.current;
    const saved: StructureChange = isNew ? { kind: "create", current: created } : { kind: "alter", base: edit.base, current: edit.current };
    requestStructureChange({
      target: tab.target,
      place,
      change: saved,
      onSaved: isNew
        ? () => openStructureTabInPlaceOf(tabId, place, { schema: created.schema, name: created.name, kind: "table" })
        // Read again first, so the tab goes from the change straight to the table that has it.
        : () => { void reload().finally(clearEdit); },
    });
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (!editable || !tabId) return;
    const onKey = (e: KeyboardEvent) => {
      if (!useKeybindingsStore.getState().matchesEvent(e, "save-prevent") || !inFront(tabId)) return;
      // A dialog open over the tab has the keyboard, Save changes included.
      if (useStructureSave.getState().request || (e.target as Element | null)?.closest?.('[role="dialog"], [role="alertdialog"]')) return;
      e.preventDefault();
      saveRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable, tabId]);

  const front = usePanelStore((s) => !!tabId && s.panels[s.focusedPanelId]?.activeTabId === tabId);
  const hasColumns = (model?.columns.length ?? 0) > 0;
  const hasPrimaryKey = !!model?.primaryKey;
  useEffect(() => {
    if (!front || !editable || !tabId) return;
    return offerTableEditorCommands(tabId, [
      { id: "add-column", label: "Add column", run: () => setDialog({ kind: "column", id: null }) },
      ...(hasColumns ? [
        { id: "add-index", label: "Add index", run: () => setDialog({ kind: "key", keyKind: "index", id: null }) },
        ...(hasPrimaryKey ? [] : [{ id: "add-primary-key", label: "Add primary key", run: () => setDialog({ kind: "key", keyKind: "primaryKey", id: null }) }]),
        { id: "add-foreign-key", label: "Add foreign key", run: () => setDialog({ kind: "foreignKey", id: null }) },
        { id: "add-unique", label: "Add unique", run: () => setDialog({ kind: "key", keyKind: "unique", id: null }) },
      ] : []),
    ]);
  }, [front, editable, tabId, hasColumns, hasPrimaryKey]);

  return {
    model, isNew, editable, dirty, canSave, save, reset, change, dialog,
    openDialog: setDialog,
    closeDialog: useCallback(() => setDialog(null), []),
  };
}
