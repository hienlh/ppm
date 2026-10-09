/**
 * The palette's database entries that depend on what is in front: New table on the database the
 * sidebar shows, the table editor's own commands while an editable Structure tab is the active
 * one, and DBGate's Export database and Import data, on the database the sidebar shows when there
 * is one. None on a phone, where neither the table editor nor the Import/Export tab is.
 *
 * Each opens an editor, a dialog or a tab and saves nothing by itself, so none changes data. The
 * list is published to the command registry, which is how the keyboard and the PPM Assistant see
 * the same entries the palette does.
 */
import { useEffect, useMemo, type ElementType } from "react";
import { ArrowRightFromLine, CheckCircle, Key, Link, ListOrdered, Plus, Table, Upload } from "@/lib/icons";
import { useSettingsStore } from "@/stores/settings-store";
import { useDbExplorer } from "@/components/database/explorer/db-explorer-store";
import { newTableConnection, openNewTableOnCurrentDatabase } from "@/components/database/explorer/open-new-table";
import { useTableEditorCommands } from "@/components/database/table-editor/table-editor-commands";
import { openExportOfCurrentDatabase, openImportIntoCurrentDatabase } from "@/components/database/impexp/open-impexp-tab";
import { publishCommandSource, type AppCommand } from "@/lib/commands/command-registry";

const EDITOR_ICONS: Record<string, ElementType> = {
  "add-column": Plus,
  "add-index": ListOrdered,
  "add-primary-key": Key,
  "add-foreign-key": Link,
  "add-unique": CheckCircle,
};

export function useDbPaletteCommands(isMobile: boolean): AppCommand[] {
  const editorCommands = useTableEditorCommands((s) => s.commands);
  // Read so the entry follows the database the sidebar shows and the connection list as it loads.
  const current = useSettingsStore((s) => s.dbExplorerView.current);
  const connections = useDbExplorer((s) => s.connections);

  const commands = useMemo<AppCommand[]>(() => {
    if (isMobile) return [];
    const newTable: AppCommand[] = current && newTableConnection() ? [{
      id: "db-new-table", label: "New table", icon: Table, changesData: false, closePaletteFirst: true,
      keywords: "database create table structure sql",
      run: () => openNewTableOnCurrentDatabase(),
    }] : [];
    const editor: AppCommand[] = editorCommands.map((c) => ({
      id: `table-editor:${c.id}`, label: c.label, hint: "Table editor", icon: EDITOR_ICONS[c.id] ?? Plus,
      changesData: false, closePaletteFirst: true,
      keywords: "table editor structure column index key constraint",
      run: () => c.run(),
    }));
    const impExp: AppCommand[] = [
      {
        id: "db-export-database", label: "Export database", icon: ArrowRightFromLine, changesData: false, closePaletteFirst: true,
        keywords: "database export tables csv json excel xlsx xml sql ndjson zip file",
        run: () => openExportOfCurrentDatabase(),
      },
      {
        id: "db-import-data", label: "Import data", icon: Upload, changesData: false, closePaletteFirst: true,
        keywords: "database import upload csv json ndjson file table",
        run: () => openImportIntoCurrentDatabase(),
      },
    ];
    return [...editor, ...newTable, ...impExp];
  }, [isMobile, current, connections, editorCommands]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => publishCommandSource("db", commands), [commands]);
  return commands;
}
