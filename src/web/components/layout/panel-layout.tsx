import { useEffect, useCallback, memo } from "react";
import { Panel, Group, Separator } from "react-resizable-panels";
import { GripVertical, GripHorizontal } from "lucide-react";
import { usePanelStore } from "@/stores/panel-store";
import { createPanel } from "@/stores/panel-utils";
import { useMediaQuery } from "@/hooks/use-media-query";
import { EditorPanel } from "./editor-panel";
import { DockPanel } from "./dock-panel";

interface PanelLayoutProps {
  projectName: string;
}

export const PanelLayout = memo(function PanelLayout({ projectName }: PanelLayoutProps) {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const grid = usePanelStore((s) =>
    s.currentProject === projectName ? s.grid : (s.projectGrids[projectName] ?? [[]]),
  );
  const focusedPanelId = usePanelStore((s) => s.focusedPanelId);
  const dock = usePanelStore((s) => s.dock);
  const currentProject = usePanelStore((s) => s.currentProject);
  const panelCount = grid.flat().length;

  // One PanelLayout is mounted per open project (hidden except the active one)
  // for keep-alive. The dock uses a single shared "__dock__" slot id, so only
  // the ACTIVE project's layout may render it — otherwise multiple layouts would
  // register the same slot and the terminal could reparent into a hidden layout.
  const isActiveProject = currentProject === projectName;

  // Recover from empty grid (corrupt persisted state or edge-case bug)
  useEffect(() => {
    if (panelCount === 0) {
      const p = createPanel();
      usePanelStore.setState((s) => ({
        panels: { ...s.panels, [p.id]: p },
        grid: [[p.id]],
        focusedPanelId: p.id,
      }));
    }
  }, [panelCount]);

  // Persist dock height when user drags the resize handle.
  // onResize fires with the dock Panel's new size as a percentage.
  const handleDockPanelResize = useCallback(({ asPercentage }: { asPercentage: number }) => {
    usePanelStore.getState().setDockHeight(asPercentage);
  }, []);

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

  // Dock hidden, or this is a non-active project's (hidden) layout — render grid
  // only. Only the active project hosts the shared dock slot.
  if (!dock.visible || !isActiveProject) {
    return <>{gridArea}</>;
  }

  // Dock visible — wrap grid + dock in a parent vertical Group.
  // The grid Panel (flex-1 remaining) sits above; DockPanel gets dock.height%.
  // minSize 10% keeps the dock usable; maxSize 85% mirrors the clamp in setDockHeight.
  // Sizes MUST be percentage strings — bare numbers are interpreted as PIXELS
  // by react-resizable-panels (v4), which collapses the dock to a thin strip
  // and can throw inside <Group>.
  return (
    <Group orientation="vertical" style={{ height: "100%" }}>
      <Panel minSize="15%">
        {gridArea}
      </Panel>
      <ResizeHandle orientation="horizontal" />
      <Panel defaultSize={`${dock.height}%`} minSize="10%" maxSize="85%" onResize={handleDockPanelResize}>
        <DockPanel />
      </Panel>
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
        ${isVertical ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"}
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
