import { useEffect, useCallback, useRef, memo } from "react";
import { Panel, Group, Separator } from "react-resizable-panels";
import { GripVertical, GripHorizontal } from "lucide-react";
import { usePanelStore } from "@/stores/panel-store";
import { useSettingsStore } from "@/stores/settings-store";
import { createPanel } from "@/stores/panel-utils";
import { useMediaQuery } from "@/hooks/use-media-query";
import { EditorPanel } from "./editor-panel";
import { DockPanel } from "./dock-panel";
import { resolveDockLayout } from "./dock-layout";

interface PanelLayoutProps {
  projectName: string;
}

// Stable empty-grid reference. Returning a fresh `[[]]` from the store selector
// makes useSyncExternalStore see a new snapshot every read → infinite re-render
// (React #185) while a not-yet-loaded project's layout is mounted during the
// async switchProject/hydrate gap.
const EMPTY_GRID: string[][] = [[]];

export const PanelLayout = memo(function PanelLayout({ projectName }: PanelLayoutProps) {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const grid = usePanelStore((s) =>
    s.currentProject === projectName ? s.grid : (s.projectGrids[projectName] ?? EMPTY_GRID),
  );
  const focusedPanelId = usePanelStore((s) => s.focusedPanelId);
  const dock = usePanelStore((s) => s.dock);
  const dockExpanded = usePanelStore((s) => s.dockExpanded);
  const dockPosition = useSettingsStore((s) => s.dockPosition);
  const currentProject = usePanelStore((s) => s.currentProject);
  const panelCount = grid.flat().length;

  // One PanelLayout is mounted per open project (hidden except the active one)
  // for keep-alive. The dock uses a single shared "__dock__" slot id, so only
  // the ACTIVE project's layout may render it — otherwise multiple layouts would
  // register the same slot and the terminal could reparent into a hidden layout.
  const isActiveProject = currentProject === projectName;

  // Recover from empty grid (corrupt persisted state or edge-case bug).
  // Only the active project may touch the shared grid/focusedPanelId — a hidden
  // keep-alive layout for a not-yet-loaded project has an empty grid too, and
  // recovering it here would clobber the current project's grid before its own
  // switchProject completes.
  useEffect(() => {
    if (isActiveProject && panelCount === 0) {
      const p = createPanel();
      usePanelStore.setState((s) => ({
        panels: { ...s.panels, [p.id]: p },
        grid: [[p.id]],
        focusedPanelId: p.id,
      }));
    }
  }, [isActiveProject, panelCount]);

  // Persist dock height when user drags the resize handle.
  // onResize fires with the dock Panel's new size as a percentage.
  const handleDockPanelResize = useCallback(({ asPercentage }: { asPercentage: number }) => {
    // While maximized, the group remounts at the expanded size and fires onResize —
    // don't let that clobber the user's saved height, or "restore" can't return to it.
    if (usePanelStore.getState().dockExpanded) return;
    usePanelStore.getState().setDockHeight(asPercentage);
  }, []);

  // Freeze the dock Panel `defaultSize` per layout key. onResize updates dock.height on
  // every drag tick; if that flowed into `defaultSize` (a mount-only prop), react-resizable-panels
  // re-baselines the panel mid-drag and the FIRST drag loses its pointer grip after a short move
  // (2nd drag works because height already matches). The ref only refreshes when the key
  // (position/expanded) changes — i.e. on a maximize/restore/position remount, not during a drag.
  const dockSizeRef = useRef<{ key: string; size: string }>({ key: "", size: "" });

  if (panelCount === 0) return null;

  // Mobile: render only the focused panel (tabs are merged in MobileNav).
  // Dock on mobile is handled by phase 07 (bottom sheet).
  if (!isDesktop) {
    const allPanelIds = grid.flat();
    const panelId = allPanelIds.includes(focusedPanelId) ? focusedPanelId : allPanelIds[0];
    if (!panelId) return null;
    return <EditorPanel panelId={panelId} projectName={projectName} />;
  }

  // Desktop grid area — single-panel and multi-panel branches are unchanged.
  // Extracted into a variable so we can optionally wrap it with the dock Group.
  const gridArea = panelCount === 1 && grid[0]?.[0]
    ? <EditorPanel panelId={grid[0][0]} projectName={projectName} />
    : (
      <Group orientation="vertical" style={{ height: "100%" }}>
        {grid.map((row, rowIdx) => (
          <RowGroup key={`row-${rowIdx}`} row={row} rowIdx={rowIdx} totalRows={grid.length} projectName={projectName} />
        ))}
      </Group>
    );

  // Non-active projects (hidden keep-alive layouts) render the grid only — only the
  // active project hosts the shared dock slot.
  if (!isActiveProject) {
    return <>{gridArea}</>;
  }

  // The Group + grid Panel are ALWAYS rendered (dock visible or not); the dock Panel +
  // its handle are conditional. Sizes MUST be percentage strings — bare numbers are
  // interpreted as PIXELS by react-resizable-panels v4. resolveDockLayout guarantees %.
  const layout = resolveDockLayout(dockPosition, dock.height, dockExpanded);
  // Handle orientation is perpendicular to the Group: vertical group → horizontal handle.
  const handleOrientation = layout.orientation === "vertical" ? "horizontal" : "vertical";
  // Stable defaultSize: refresh only on layout-key change (mount/remount), never on a
  // live dock.height change during a drag (prevents first-drag losing its grip).
  const sizeKey = `${dockPosition}-${dockExpanded}`;
  if (dockSizeRef.current.key !== sizeKey) {
    dockSizeRef.current = { key: sizeKey, size: layout.dockSize };
  }
  const gridPanelEl = (
    <Panel minSize="15%">
      {gridArea}
    </Panel>
  );
  // Dock + handle are conditional. The grid Panel keeps a FIXED child position via the
  // dockFirst ternary (null placeholders when hidden), so toggling the dock never
  // reorders/remounts the grid subtree — otherwise TabPool reparents the grid's tabs and
  // scrolled chat tabs jump to the top. `sizeKey` excludes dock.visible, so the Group is
  // preserved across a visibility toggle; it changes only on maximize/restore/position,
  // which remount to re-apply the mount-only `defaultSize`.
  const dockPanelEl = dock.visible ? (
    <Panel defaultSize={dockSizeRef.current.size} minSize="10%" maxSize="85%" onResize={handleDockPanelResize}>
      <DockPanel borderEdge={layout.borderEdge} />
    </Panel>
  ) : null;
  const handleEl = dock.visible ? <ResizeHandle orientation={handleOrientation} /> : null;

  return (
    <Group key={sizeKey} orientation={layout.orientation} style={{ height: "100%" }}>
      {layout.dockFirst ? dockPanelEl : gridPanelEl}
      {handleEl}
      {layout.dockFirst ? gridPanelEl : dockPanelEl}
    </Group>
  );
});

function RowGroup({ row, rowIdx, totalRows, projectName }: { row: string[]; rowIdx: number; totalRows: number; projectName: string }) {
  const defaultSize = `${Math.round(100 / totalRows)}%`;
  return (
    <>
      <Panel minSize="15%" defaultSize={defaultSize}>
        {row.length === 1 ? (
          <EditorPanel panelId={row[0]!} projectName={projectName} />
        ) : (
          <Group orientation="horizontal">
            {row.map((panelId, colIdx) => (
              <ColPanel key={panelId} panelId={panelId} colIdx={colIdx} totalCols={row.length} projectName={projectName} />
            ))}
          </Group>
        )}
      </Panel>
      {rowIdx < totalRows - 1 && <ResizeHandle orientation="horizontal" />}
    </>
  );
}

function ColPanel({ panelId, colIdx, totalCols, projectName }: { panelId: string; colIdx: number; totalCols: number; projectName: string }) {
  const defaultSize = `${Math.round(100 / totalCols)}%`;
  return (
    <>
      <Panel minSize="15%" defaultSize={defaultSize}>
        <EditorPanel panelId={panelId} projectName={projectName} />
      </Panel>
      {colIdx < totalCols - 1 && <ResizeHandle orientation="vertical" />}
    </>
  );
}

function ResizeHandle({ orientation }: { orientation: "horizontal" | "vertical" }) {
  const isVertical = orientation === "vertical";
  return (
    <Separator
      className={`
        group/handle relative flex items-center justify-center
        ${isVertical ? "w-px cursor-col-resize" : "h-px cursor-row-resize"}
        bg-border/30 hover:bg-primary/30 active:bg-primary/50
        transition-colors duration-150
      `}
    >
      <div className="absolute can-hover:opacity-0 can-hover:group-hover/handle:opacity-70 transition-opacity text-foreground/50">
        {isVertical ? <GripVertical className="size-3" /> : <GripHorizontal className="size-3" />}
      </div>
    </Separator>
  );
}
