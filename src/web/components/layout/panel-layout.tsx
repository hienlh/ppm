import { Panel, Group, Separator } from "react-resizable-panels";
import { GripVertical, GripHorizontal } from "lucide-react";
import { usePanelStore } from "@/stores/panel-store";
import { EditorPanel } from "./editor-panel";

export function PanelLayout() {
  const grid = usePanelStore((s) => s.grid);
  const panelCount = Object.keys(usePanelStore((s) => s.panels)).length;

  if (panelCount <= 1 && grid[0]?.[0]) {
    return <EditorPanel panelId={grid[0][0]} />;
  }

  return (
    <Group orientation="horizontal" style={{ height: "100%" }}>
      {grid.map((column, colIdx) => (
        <ColumnPanel key={`col-${colIdx}`} column={column} colIdx={colIdx} totalCols={grid.length} />
      ))}
    </Group>
  );
}

function ColumnPanel({ column, colIdx, totalCols }: { column: string[]; colIdx: number; totalCols: number }) {
  const defaultSize = `${Math.round(100 / totalCols)}%`;
  return (
    <>
      <Panel minSize="15%" defaultSize={defaultSize}>
        {column.length === 1 ? (
          <EditorPanel panelId={column[0]!} />
        ) : (
          <Group orientation="vertical">
            {column.map((panelId, rowIdx) => (
              <RowPanel key={panelId} panelId={panelId} rowIdx={rowIdx} totalRows={column.length} />
            ))}
          </Group>
        )}
      </Panel>
      {colIdx < totalCols - 1 && <ResizeHandle orientation="vertical" />}
    </>
  );
}

function RowPanel({ panelId, rowIdx, totalRows }: { panelId: string; rowIdx: number; totalRows: number }) {
  const defaultSize = `${Math.round(100 / totalRows)}%`;
  return (
    <>
      <Panel minSize="15%" defaultSize={defaultSize}>
        <EditorPanel panelId={panelId} />
      </Panel>
      {rowIdx < totalRows - 1 && <ResizeHandle orientation="horizontal" />}
    </>
  );
}

function ResizeHandle({ orientation }: { orientation: "horizontal" | "vertical" }) {
  const isVertical = orientation === "vertical";
  return (
    <Separator
      className={`
        group/handle relative flex items-center justify-center
        ${isVertical ? "w-2 cursor-col-resize" : "h-2 cursor-row-resize"}
        bg-border/50 hover:bg-primary/30 active:bg-primary/50
        transition-colors duration-150
      `}
    >
      <div className="absolute opacity-0 group-hover/handle:opacity-70 transition-opacity text-foreground/50">
        {isVertical ? <GripVertical className="size-3" /> : <GripHorizontal className="size-3" />}
      </div>
    </Separator>
  );
}
