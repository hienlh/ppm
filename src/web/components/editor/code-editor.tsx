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
import { api } from "../../lib/api-client";
import { useTabStore } from "../../stores/tab.store";
import { Loader2 } from "lucide-react";

function getLanguageExtension(filename: string): Extension[] {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return [javascript({ typescript: true, jsx: ext === "tsx" })];
    case "js":
    case "jsx":
      return [javascript({ jsx: ext === "jsx" })];
    case "py":
      return [python()];
    case "html":
      return [html()];
    case "css":
      return [css()];
    case "json":
      return [json()];
    case "md":
      return [markdown()];
    default:
      return [];
  }
}

interface CodeEditorProps {
  filePath: string;
  tabId: string;
}

export function CodeEditor({ filePath, tabId }: CodeEditorProps) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unsaved, setUnsaved] = useState(false);
  const { updateTab } = useTabStore();
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filename = filePath.split("/").pop() ?? filePath;

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .get<{ content: string; encoding: string }>(`/api/files/read?path=${encodeURIComponent(filePath)}`)
      .then((res) => setContent(res.content))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [filePath]);

  const handleChange = useCallback(
    (value: string) => {
      setContent(value);
      setUnsaved(true);
      updateTab(tabId, { title: `${filename} •` });

      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        try {
          await api.put("/api/files/write", { path: filePath, content: value });
          setUnsaved(false);
          updateTab(tabId, { title: filename });
        } catch (err) {
          console.error("Auto-save failed:", err);
        }
      }, 1000);
    },
    [filePath, filename, tabId, updateTab],
  );

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-destructive text-sm px-4 text-center">
        {error}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {unsaved && (
        <div className="h-1 bg-yellow-500/40 shrink-0" />
      )}
      <CodeMirror
        value={content}
        theme={oneDark}
        extensions={getLanguageExtension(filename)}
        onChange={handleChange}
        className="flex-1 overflow-auto text-sm"
        height="100%"
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          autocompletion: true,
        }}
      />
    </div>
  );
}
