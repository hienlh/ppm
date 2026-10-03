/**
 * The Database sidebar in DBGate's two parts: CONNECTIONS above, and TABLES, VIEWS, FUNCTIONS of
 * the current database below, with a line between them to share the height. Either part folds
 * to its header; the other then takes the height. On a phone both sit in the drawer.
 */
import { useRef, useState } from "react";
import { Database } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { SidebarHeader } from "@/components/ui/sidebar-header";
import { useSettingsStore } from "@/stores/settings-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { DEFAULT_DB_EXPLORER_VIEW } from "../../../shared/db-explorer-prefs";
import { ConnectionImportExport } from "./connection-import-export";
import { ConnectionsSection } from "./connections-section/connections-section";
import { ObjectsSection } from "./object-tree/objects-section";
import { SidebarSplit } from "./sidebar-split";
import { exportConnections, importConnections, setExplorerView } from "./explorer/db-explorer-store";
import { useDbExplorerSync } from "./explorer/use-db-explorer-sync";

interface DatabaseSidebarProps {
  /** Called once the sidebar has opened a tab — the phone's drawer closes so the tab can be seen. */
  onNavigate?: () => void;
}

export function DatabaseSidebar({ onNavigate }: DatabaseSidebarProps = {}) {
  useDbExplorerSync();
  const view = useSettingsStore((s) => s.dbExplorerView);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [dragged, setDragged] = useState<number | null>(null);
  // A phone has no line to drag, so a share set on a wider screen could never be undone there.
  const split = useIsMobile() ? DEFAULT_DB_EXPLORER_VIEW.split : dragged ?? view.split;
  const connectionsOpen = !view.connectionsCollapsed;
  const objectsOpen = !view.objectsCollapsed;
  const both = connectionsOpen && objectsOpen;

  return (
    <div className="flex h-full flex-col">
      <SidebarHeader icon={Database} title="Database">
        <ConnectionImportExport onExport={exportConnections} onImport={importConnections} />
      </SidebarHeader>

      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
        <ConnectionsSection
          collapsed={!connectionsOpen}
          onToggleCollapsed={() => setExplorerView({ connectionsCollapsed: connectionsOpen })}
          onNavigate={onNavigate}
          className={both ? "shrink-0 grow-0" : connectionsOpen ? "flex-1" : "shrink-0"}
          style={both ? { flexBasis: `${split * 100}%` } : undefined}
        />
        {both && (
          <SidebarSplit
            split={split}
            containerRef={bodyRef}
            onMove={setDragged}
            onCommit={(next) => {
              setDragged(null);
              if (next !== view.split) setExplorerView({ split: next });
            }}
          />
        )}
        <ObjectsSection
          collapsed={!objectsOpen}
          onToggleCollapsed={() => setExplorerView({ objectsCollapsed: objectsOpen })}
          onNavigate={onNavigate}
          // The split is the line between the two; without it — folded, or on a phone — a border is.
          className={cn(objectsOpen ? "flex-1 basis-0" : "shrink-0", !both && "border-t border-border", "max-md:border-t max-md:border-border")}
        />
      </div>
    </div>
  );
}
