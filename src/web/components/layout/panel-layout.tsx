import { Panel, Group, Separator } from "react-resizable-panels";
import { GripVertical, GripHorizontal } from "lucide-react";
import { usePanelStore } from "@/stores/panel-store";
import { EditorPanel } from "./editor-panel";

interface PanelLayoutProps {
  projectName: string;
}

export function PanelLayout({ projectName }: PanelLayoutProps) {
  const grid = usePanelStore((s) =>
    s.currentProject === projectName ? s.grid : (s.projectGrids[projectName] ?? [[]]),
  );
  const panelCount = grid.flat().length;

  if (panelCount <= 1 && grid[0]?.[0]) {
    return <EditorPanel panelId={grid[0][0]} projectName={projectName} />;
  }

  return (
    <Group orientation="vertical" style={{ height: "100%" }}>
      {grid.map((row, rowIdx) => (
        <RowGroup key={`row-${rowIdx}`} row={row} rowIdx={rowIdx} totalRows={grid.length} projectName={projectName} />
      ))}
    </Group>
  );
}

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
      <div className="absolute opacity-0 group-hover/handle:opacity-70 transition-opacity text-foreground/50">
        {isVertical ? <GripVertical className="size-3" /> : <GripHorizontal className="size-3" />}
      </div>
    </Separator>
  );
}
