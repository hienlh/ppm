/**
 * The palette's database entries that depend on what is in front: New table on the database the
 * sidebar shows, the table editor's own commands while an editable Structure tab is the active
 * one, and DBGate's Export database and Import data, on the database the sidebar shows when there
 * is one. None on a phone, where neither the table editor nor the Import/Export tab is.
 */
import { useMemo, type ElementType } from "react";
import { ArrowRightFromLine, CheckCircle, Key, Link, ListOrdered, Plus, Table, Upload } from "@/lib/icons";
import { useSettingsStore } from "@/stores/settings-store";
import { useDbExplorer } from "@/components/database/explorer/db-explorer-store";
import { newTableConnection, openNewTableOnCurrentDatabase } from "@/components/database/explorer/open-new-table";
import { useTableEditorCommands } from "@/components/database/table-editor/table-editor-commands";
import { openExportOfCurrentDatabase, openImportIntoCurrentDatabase } from "@/components/database/impexp/open-impexp-tab";
import type { CommandItem } from "./command-palette";

const EDITOR_ICONS: Record<string, ElementType> = {
  "add-column": Plus,
  "add-index": ListOrdered,
  "add-primary-key": Key,
  "add-foreign-key": Link,
  "add-unique": CheckCircle,
};

export function useDbPaletteCommands(isMobile: boolean, onClose: () => void): CommandItem[] {
  const editorCommands = useTableEditorCommands((s) => s.commands);
  // Read so the entry follows the database the sidebar shows and the connection list as it loads.
  const current = useSettingsStore((s) => s.dbExplorerView.current);
  const connections = useDbExplorer((s) => s.connections);

  return useMemo(() => {
    if (isMobile) return [];
    const newTable: CommandItem[] = current && newTableConnection() ? [{
      id: "db-new-table", label: "New table", icon: Table, group: "action",
      keywords: "database create table structure sql",
      action: () => { onClose(); openNewTableOnCurrentDatabase(); },
    }] : [];
    const editor: CommandItem[] = editorCommands.map((c) => ({
      id: `table-editor:${c.id}`, label: c.label, hint: "Table editor", icon: EDITOR_ICONS[c.id] ?? Plus, group: "action",
      keywords: "table editor structure column index key constraint",
      action: () => { onClose(); c.run(); },
    }));
    const impExp: CommandItem[] = [
      {
        id: "db-export-database", label: "Export database", icon: ArrowRightFromLine, group: "action",
        keywords: "database export tables csv json excel xlsx xml sql ndjson zip file",
        action: () => { onClose(); openExportOfCurrentDatabase(); },
      },
      {
        id: "db-import-data", label: "Import data", icon: Upload, group: "action",
        keywords: "database import upload csv json ndjson file table",
        action: () => { onClose(); openImportIntoCurrentDatabase(); },
      },
    ];
    return [...editor, ...newTable, ...impExp];
  }, [isMobile, current, connections, editorCommands, onClose]); // eslint-disable-line react-hooks/exhaustive-deps
}
