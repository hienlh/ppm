import { useState, useCallback, useRef } from "react";
import { Eye, Sparkles, WrapText, ExternalLink, X, GripHorizontal } from "lucide-react";
import Editor from "@monaco-editor/react";
import { Loader2 } from "lucide-react";
import { useMonacoTheme } from "@/lib/use-monaco-theme";

export interface PreviewData {
  title: string;
  content: string;
  language: string;
  viewerKey: string;
}

interface PreviewPanelProps {
  data: PreviewData;
  onClose: () => void;
  onOpenInTab: () => void;
}

/** Inline preview panel for cell/row content with Monaco editor */
export function GlideDataPreviewPanel({ data, onClose, onOpenInTab }: PreviewPanelProps) {
  const monacoTheme = useMonacoTheme();
  const [wordWrap, setWordWrap] = useState(true);
  const [displayContent, setDisplayContent] = useState(data.content);
  const [beautified, setBeautified] = useState(false);
  const canBeautify = data.language === "json" || data.language === "xml";

  // Reset state when data changes
  const prevKey = useRef(data.title);
  if (prevKey.current !== data.title) {
    prevKey.current = data.title;
    setDisplayContent(data.content);
    setBeautified(false);
  }

  const toggleBeautify = useCallback(() => {
    if (beautified) {
      setDisplayContent(data.content);
      setBeautified(false);
    } else if (data.language === "json") {
      try { setDisplayContent(JSON.stringify(JSON.parse(data.content.trim()), null, 2)); setBeautified(true); } catch { /* invalid */ }
    } else if (data.language === "xml") {
      let depth = 0;
      const formatted = data.content.trim().replace(/>\s*</g, ">\n<").split("\n").map((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("</")) depth = Math.max(0, depth - 1);
        const indented = "  ".repeat(depth) + trimmed;
        if (trimmed.startsWith("<") && !trimmed.startsWith("</") && !trimmed.endsWith("/>") && !trimmed.startsWith("<?")) depth++;
        return indented;
      }).join("\n");
      setDisplayContent(formatted);
      setBeautified(true);
    }
  }, [beautified, data.content, data.language]);

  const [panelHeight, setPanelHeight] = useState(200);
  const handleDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = panelHeight;
    const onMove = (ev: MouseEvent) => setPanelHeight(Math.max(80, startH + (startY - ev.clientY)));
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [panelHeight]);

  return (
    <div className="shrink-0 border-t border-border flex flex-col" style={{ height: panelHeight }}>
      <div onMouseDown={handleDrag}
        className="shrink-0 h-1.5 cursor-row-resize bg-border/50 hover:bg-primary/30 flex items-center justify-center transition-colors">
        <GripHorizontal className="size-3 text-muted-foreground/50" />
      </div>
      <div className="flex items-center gap-1 px-2 py-1 bg-muted/50 border-b border-border shrink-0">
        <Eye className="size-3 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground truncate flex-1">{data.title}</span>
        {canBeautify && (
          <button type="button" onClick={toggleBeautify} title={beautified ? "Raw" : "Beautify"}
            className={`p-0.5 rounded transition-colors ${beautified ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}>
            <Sparkles className="size-3" />
          </button>
        )}
        <button type="button" onClick={() => setWordWrap(!wordWrap)} title={wordWrap ? "No wrap" : "Word wrap"}
          className={`p-0.5 rounded transition-colors ${wordWrap ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}>
          <WrapText className="size-3" />
        </button>
        <button type="button" onClick={onOpenInTab} title="Open in new tab"
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
          <ExternalLink className="size-3" />
          <span className="hidden sm:inline">Open in Tab</span>
        </button>
        <button type="button" onClick={onClose} title="Close preview (Esc)"
          className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors">
          <X className="size-3" />
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <Editor
          height="100%"
          language={data.language === "plaintext" ? undefined : data.language}
          value={displayContent}
          theme={monacoTheme}
          options={{
            readOnly: true, minimap: { enabled: false }, scrollBeyondLastLine: false,
            wordWrap: wordWrap ? "on" : "off", lineNumbers: "on", fontSize: 12,
            folding: true, bracketPairColorization: { enabled: true },
            domReadOnly: true, contextmenu: false, overviewRulerLanes: 0,
          }}
          loading={<Loader2 className="size-4 animate-spin text-muted-foreground" />}
        />
      </div>
    </div>
  );
}
