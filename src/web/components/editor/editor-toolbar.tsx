import { Code, Eye, WrapText, Table, Download, RefreshCw, UserRound } from "lucide-react";
import { downloadFile } from "@/lib/file-download";

interface EditorToolbarProps {
  ext: string;
  mdMode?: "edit" | "preview";
  onMdModeChange?: (mode: "edit" | "preview") => void;
  csvMode?: "table" | "raw";
  onCsvModeChange?: (mode: "table" | "raw") => void;
  wordWrap: boolean;
  onToggleWordWrap: () => void;
  /** Omitted for buffers git cannot blame (untitled, inline preview). */
  inlineBlame?: boolean;
  onToggleInlineBlame?: () => void;
  /** Blame is on but hidden because the buffer has unsaved edits. */
  blameStale?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
  filePath?: string;
  projectName?: string;
  className?: string;
}

function ToolbarButton({
  active,
  onClick,
  icon: Icon,
  label,
  title,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      <Icon className="size-3" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

export function EditorToolbar({
  ext,
  mdMode,
  onMdModeChange,
  csvMode,
  onCsvModeChange,
  wordWrap,
  onToggleWordWrap,
  inlineBlame,
  onToggleInlineBlame,
  blameStale,
  onRefresh,
  refreshing,
  filePath,
  projectName,
  className,
}: EditorToolbarProps) {
  const isMarkdown = ext === "md" || ext === "mdx";
  const isCsv = ext === "csv";

  return (
    <div className={className}>
      {isMarkdown && onMdModeChange && (
        <>
          <ToolbarButton active={mdMode === "edit"} onClick={() => onMdModeChange("edit")} icon={Code} label="Edit" />
          <ToolbarButton active={mdMode === "preview"} onClick={() => onMdModeChange("preview")} icon={Eye} label="Preview" />
        </>
      )}
      {isCsv && onCsvModeChange && (
        <>
          <ToolbarButton active={csvMode === "table"} onClick={() => onCsvModeChange("table")} icon={Table} label="Table" />
          <ToolbarButton active={csvMode === "raw"} onClick={() => onCsvModeChange("raw")} icon={Code} label="Raw" />
        </>
      )}
      <ToolbarButton
        active={wordWrap}
        onClick={onToggleWordWrap}
        icon={WrapText}
        label="Wrap"
      />
      {onToggleInlineBlame && (
        <ToolbarButton
          active={inlineBlame === true}
          onClick={onToggleInlineBlame}
          icon={UserRound}
          label="Blame"
          title={
            inlineBlame && blameStale
              ? "Blame is hidden until this file is saved — the line numbers have moved"
              : "Inline blame (Alt+B)"
          }
        />
      )}
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          title="Reload file from disk"
          className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`size-3 ${refreshing ? "animate-spin" : ""}`} />
          <span className="hidden sm:inline">Refresh</span>
        </button>
      )}
      {filePath && projectName && (
        <ToolbarButton
          active={false}
          onClick={() => downloadFile(projectName, filePath)}
          icon={Download}
          label="Download"
        />
      )}
    </div>
  );
}
