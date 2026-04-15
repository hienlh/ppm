import { useEffect, useState, useRef, useCallback } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as MonacoType from "monaco-editor";
import { api, projectUrl } from "@/lib/api-client";
import { useSettingsStore } from "@/stores/settings-store";
import { useMonacoTheme } from "@/lib/use-monaco-theme";
import { Loader2 } from "lucide-react";

function getMonacoLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    js: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript",
    py: "python", html: "html",
    css: "css", scss: "scss",
    json: "json", md: "markdown", mdx: "markdown",
    yaml: "yaml", yml: "yaml",
    sh: "shell", bash: "shell",
    go: "go", rs: "rust", java: "java",
    rb: "ruby", php: "php", swift: "swift",
    sql: "sql", xml: "xml", toml: "toml",
  };
  return map[ext] ?? "plaintext";
}

interface ConflictRegion {
  id: number;
  startLine: number;       // 1-indexed, line of <<<<<<< marker
  separatorLine: number;   // line of =======
  endLine: number;         // line of >>>>>>> marker
  currentContent: string;
  incomingContent: string;
  currentLabel: string;
  incomingLabel: string;
}

function parseConflicts(content: string): ConflictRegion[] {
  const lines = content.split("\n");
  const regions: ConflictRegion[] = [];
  let i = 0;
  let id = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("<<<<<<<")) {
      const startLine = i;
      const currentLabel = line.substring(7).trim();
      const currentLines: string[] = [];
      i++;

      while (i < lines.length && !lines[i]!.startsWith("=======")) {
        currentLines.push(lines[i]!);
        i++;
      }
      if (i >= lines.length) break;

      const separatorLine = i;
      const incomingLines: string[] = [];
      i++;

      while (i < lines.length && !lines[i]!.startsWith(">>>>>>>")) {
        incomingLines.push(lines[i]!);
        i++;
      }
      if (i >= lines.length) break;

      const incomingLabel = lines[i]!.substring(7).trim();

      regions.push({
        id: id++,
        startLine: startLine + 1,
        separatorLine: separatorLine + 1,
        endLine: i + 1,
        currentContent: currentLines.join("\n"),
        incomingContent: incomingLines.join("\n"),
        currentLabel,
        incomingLabel,
      });
    }
    i++;
  }
  return regions;
}

interface ConflictEditorProps {
  metadata?: Record<string, unknown>;
  tabId?: string;
}

export function ConflictEditor({ metadata }: ConflictEditorProps) {
  const filePath = metadata?.filePath as string | undefined;
  const projectName = metadata?.projectName as string | undefined;

  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [conflictCount, setConflictCount] = useState(0);
  const editorRef = useRef<MonacoType.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof MonacoType | null>(null);
  const widgetsRef = useRef<MonacoType.editor.IContentWidget[]>([]);
  const decorationsRef = useRef<MonacoType.editor.IEditorDecorationsCollection | null>(null);

  const { wordWrap } = useSettingsStore();
  const monacoTheme = useMonacoTheme();

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState<number | undefined>();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setContainerHeight(Math.floor(entry.contentRect.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Load file content
  useEffect(() => {
    if (!filePath || !projectName) return;
    setLoading(true);
    api
      .get<{ content: string }>(`${projectUrl(projectName)}/files/read?path=${encodeURIComponent(filePath)}`)
      .then((data) => {
        setContent(data.content);
        setLoading(false);
      })
      .catch((e: Error) => {
        setError(e.message || "Failed to load file");
        setLoading(false);
      });
  }, [filePath, projectName]);

  const refreshConflicts = useCallback(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    const value = editor.getModel()?.getValue() || "";
    const regions = parseConflicts(value);
    setConflictCount(regions.length);

    // Clear old widgets
    for (const w of widgetsRef.current) {
      editor.removeContentWidget(w);
    }
    widgetsRef.current = [];

    // Clear old decorations
    if (decorationsRef.current) {
      decorationsRef.current.clear();
    }

    if (regions.length === 0) return;

    // Apply decorations
    const decos: MonacoType.editor.IModelDeltaDecoration[] = [];
    for (const region of regions) {
      // Marker lines
      decos.push({
        range: new monaco.Range(region.startLine, 1, region.startLine, 1),
        options: { isWholeLine: true, className: "conflict-marker-line", glyphMarginClassName: "conflict-glyph-current" },
      });
      decos.push({
        range: new monaco.Range(region.separatorLine, 1, region.separatorLine, 1),
        options: { isWholeLine: true, className: "conflict-marker-line" },
      });
      decos.push({
        range: new monaco.Range(region.endLine, 1, region.endLine, 1),
        options: { isWholeLine: true, className: "conflict-marker-line", glyphMarginClassName: "conflict-glyph-incoming" },
      });
      // Current content (green)
      if (region.separatorLine - region.startLine > 1) {
        decos.push({
          range: new monaco.Range(region.startLine + 1, 1, region.separatorLine - 1, 1),
          options: { isWholeLine: true, className: "conflict-current-content" },
        });
      }
      // Incoming content (blue)
      if (region.endLine - region.separatorLine > 1) {
        decos.push({
          range: new monaco.Range(region.separatorLine + 1, 1, region.endLine - 1, 1),
          options: { isWholeLine: true, className: "conflict-incoming-content" },
        });
      }
    }

    decorationsRef.current = editor.createDecorationsCollection(decos);

    // Add accept widgets above each conflict
    for (const region of regions) {
      const widgetId = `conflict-widget-${region.id}`;

      const domNode = document.createElement("div");
      domNode.className = "conflict-actions";
      domNode.innerHTML =
        `<span class="conflict-label">Current Change (${escHtml(region.currentLabel || "HEAD")})</span>` +
        `<button class="conflict-btn conflict-btn-current" data-action="current">Accept Current</button>` +
        `<button class="conflict-btn conflict-btn-incoming" data-action="incoming">Accept Incoming</button>` +
        `<button class="conflict-btn conflict-btn-both" data-action="both">Accept Both</button>`;

      domNode.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest("[data-action]");
        if (!btn) return;
        const action = btn.getAttribute("data-action") as "current" | "incoming" | "both";
        acceptConflict(region.id, action);
      });

      const widget: MonacoType.editor.IContentWidget = {
        getId: () => widgetId,
        getDomNode: () => domNode,
        getPosition: () => ({
          position: { lineNumber: region.startLine, column: 1 },
          preference: [monaco.editor.ContentWidgetPositionPreference.ABOVE],
        }),
      };
      editor.addContentWidget(widget);
      widgetsRef.current.push(widget);
    }
  }, []);

  const acceptConflict = useCallback(
    (regionId: number, action: "current" | "incoming" | "both") => {
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (!editor || !monaco) return;

      const model = editor.getModel();
      if (!model) return;

      const value = model.getValue();
      const regions = parseConflicts(value);
      const region = regions.find((r) => r.id === regionId);
      if (!region) return;

      let replacement: string;
      switch (action) {
        case "current":
          replacement = region.currentContent;
          break;
        case "incoming":
          replacement = region.incomingContent;
          break;
        case "both":
          replacement = region.currentContent + "\n" + region.incomingContent;
          break;
      }

      const range = new monaco.Range(region.startLine, 1, region.endLine + 1, 1);
      model.pushEditOperations(
        [],
        [{ range, text: replacement + "\n" }],
        () => null,
      );

      // Save and refresh
      saveFile(model.getValue());
      // Small delay to let the model update before refreshing decorations
      setTimeout(() => refreshConflicts(), 50);
    },
    [refreshConflicts],
  );

  const saveFile = useCallback(
    async (newContent: string) => {
      if (!filePath || !projectName) return;
      try {
        await api.put<{ written: boolean }>(`${projectUrl(projectName)}/files/write`, {
          path: filePath,
          content: newContent,
        });
      } catch (e) {
        console.error("[conflict-editor] save failed:", e);
      }
    },
    [filePath, projectName],
  );

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Inject conflict editor styles (idempotent)
    const doc = editor.getDomNode()?.ownerDocument ?? document;
    if (!doc.getElementById("conflict-editor-styles")) {
      const styleEl = doc.createElement("style");
      styleEl.id = "conflict-editor-styles";
      styleEl.textContent = `
        .conflict-current-content { background: rgba(34, 197, 94, 0.1) !important; }
        .conflict-incoming-content { background: rgba(59, 130, 246, 0.1) !important; }
        .conflict-marker-line { background: rgba(100, 100, 100, 0.15) !important; font-style: italic; }
        .conflict-glyph-current { background: #22c55e !important; }
        .conflict-glyph-incoming { background: #3b82f6 !important; }
        .conflict-actions { display: flex; gap: 8px; align-items: center; padding: 2px 0; font-size: 12px; font-family: system-ui; }
        .conflict-label { color: #22c55e; font-weight: 600; margin-right: 8px; }
        .conflict-btn { padding: 1px 8px; border-radius: 3px; border: none; cursor: pointer; font-size: 11px; opacity: 0.9; }
        .conflict-btn:hover { opacity: 1; }
        .conflict-btn-current { color: #22c55e; background: rgba(34, 197, 94, 0.15); }
        .conflict-btn-incoming { color: #3b82f6; background: rgba(59, 130, 246, 0.15); }
        .conflict-btn-both { color: #a855f7; background: rgba(168, 85, 247, 0.15); }
      `;
      doc.head?.appendChild(styleEl);
    }

    refreshConflicts();
  };

  const fileName = filePath?.split(/[\\/]/).pop() ?? "unknown";
  const language = getMonacoLanguage(fileName);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-destructive">
        {error}
      </div>
    );
  }

  return (
    <div className="h-full w-full flex flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-border bg-muted/50 flex-shrink-0">
        <span className="font-medium">{fileName}</span>
        <span className="text-muted-foreground">—</span>
        {conflictCount > 0 ? (
          <span className="text-destructive font-medium">
            {conflictCount} conflict{conflictCount !== 1 ? "s" : ""} remaining
          </span>
        ) : (
          <span className="text-green-500 font-medium">All conflicts resolved</span>
        )}
      </div>
      <div ref={containerRef} className="flex-1 min-h-0">
        {content !== null && containerHeight && (
          <Editor
            height={containerHeight}
            language={language}
            value={content}
            onMount={handleMount}
            theme={monacoTheme}
            options={{
              fontSize: 13,
              fontFamily: "Menlo, Monaco, Consolas, monospace",
              wordWrap: wordWrap ? "on" : "off",
              glyphMargin: true,
              readOnly: false,
              automaticLayout: true,
              scrollBeyondLastLine: false,
              minimap: { enabled: false },
            }}
          />
        )}
      </div>
    </div>
  );
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
