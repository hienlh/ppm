import { useEffect, useState, useCallback, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import type { Extension } from "@codemirror/state";
import { api, projectUrl } from "@/lib/api-client";
import { useTabStore } from "@/stores/tab-store";
import { Loader2 } from "lucide-react";

function getLanguageExtension(filename: string): Extension | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js":
    case "jsx":
      return javascript({ jsx: true });
    case "ts":
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "py":
      return python();
    case "html":
      return html();
    case "css":
    case "scss":
      return css();
    case "json":
      return json();
    case "md":
    case "mdx":
      return markdown();
    default:
      return null;
  }
}

interface CodeEditorProps {
  metadata?: Record<string, unknown>;
}

export function CodeEditor({ metadata }: CodeEditorProps) {
  const filePath = metadata?.filePath as string | undefined;
  const projectName = metadata?.projectName as string | undefined;
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unsaved, setUnsaved] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestContentRef = useRef<string>("");
  const { tabs, activeTabId, updateTab } = useTabStore();

  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Load file content
  useEffect(() => {
    if (!filePath || !projectName) return;
    setLoading(true);
    setError(null);

    api
      .get<{ content: string; encoding: string }>(
        `${projectUrl(projectName)}/files/read?path=${encodeURIComponent(filePath)}`,
      )
      .then((data) => {
        setContent(data.content);
        latestContentRef.current = data.content;
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load file");
        setLoading(false);
      });

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [filePath, projectName]);

  // Update tab title unsaved indicator
  useEffect(() => {
    if (!activeTab) return;
    const baseName = filePath?.split("/").pop() ?? "Untitled";
    const newTitle = unsaved ? `${baseName} \u25CF` : baseName;
    if (activeTab.title !== newTitle) {
      updateTab(activeTab.id, { title: newTitle });
    }
  }, [unsaved]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveFile = useCallback(
    async (text: string) => {
      if (!filePath || !projectName) return;
      try {
        await api.put(`${projectUrl(projectName)}/files/write`, {
          path: filePath,
          content: text,
        });
        setUnsaved(false);
      } catch {
        // Silent save failure — user sees unsaved indicator persists
      }
    },
    [filePath, projectName],
  );

  function handleChange(value: string) {
    setContent(value);
    latestContentRef.current = value;
    setUnsaved(true);

    // Debounced auto-save (1s)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveFile(latestContentRef.current);
    }, 1000);
  }

  if (!filePath || !projectName) {
    return (
      <div className="flex items-center justify-center h-full text-text-secondary text-sm">
        No file selected.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-text-secondary">
        <Loader2 className="size-5 animate-spin" />
        <span className="text-sm">Loading file...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-error text-sm">
        {error}
      </div>
    );
  }

  const extensions: Extension[] = [];
  const langExt = getLanguageExtension(filePath);
  if (langExt) extensions.push(langExt);

  return (
    <div className="h-full w-full overflow-hidden">
      <CodeMirror
        value={content ?? ""}
        onChange={handleChange}
        extensions={extensions}
        theme={oneDark}
        height="100%"
        style={{ height: "100%", fontSize: "13px", fontFamily: "var(--font-mono)" }}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          autocompletion: true,
          bracketMatching: true,
          closeBrackets: true,
          highlightActiveLine: true,
          indentOnInput: true,
        }}
      />
    </div>
  );
}
