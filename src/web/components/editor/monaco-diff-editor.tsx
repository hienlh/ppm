import { useLayoutEffect, useRef, type ComponentProps } from "react";
import { DiffEditor as MonacoDiffEditor } from "@monaco-editor/react";
import { DOTENV_LANGUAGE_ID, isDotenvFile } from "@/lib/monaco-dotenv-language";

/**
 * `@monaco-editor/react` 4.7 disposes the two models on unmount *before* the diff editor still
 * showing them, and Monaco 0.55 reports that as "TextModel got disposed before DiffEditorWidget
 * model got reset" — an uncaught error every time a diff closes, which a review stepping through
 * files does once per file. This wrapper is the library component's parent, and React runs a
 * removed subtree's cleanups parent before child, every layout one before any passive one — so
 * the models are detached and disposed here first and the library is left only the editor to
 * dispose. A layout effect is margin, not the fix: React 19.2 runs a removed subtree's passive
 * cleanups parent-first too, so a passive one here would also run before the library's.
 */
export function DiffEditor({ onMount, ...props }: ComponentProps<typeof MonacoDiffEditor>) {
  const editorRef = useRef<Parameters<NonNullable<typeof onMount>>[0] | null>(null);
  useLayoutEffect(() => () => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    editor.setModel(null);
    model?.original.dispose();
    model?.modified.dispose();
  }, []);
  return (
    <MonacoDiffEditor
      {...props}
      onMount={(editor, monaco) => {
        editorRef.current = editor;
        onMount?.(editor, monaco);
      }}
    />
  );
}

/** The Monaco language a diff of this file is coloured as. */
export function getMonacoLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    js: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript",
    py: "python", html: "html",
    css: "css", scss: "scss",
    json: "json", md: "markdown", mdx: "markdown",
    yaml: "yaml", yml: "yaml",
    sh: "shell", bash: "shell",
  };
  return map[ext] ?? (isDotenvFile(filename) ? DOTENV_LANGUAGE_ID : "plaintext");
}
