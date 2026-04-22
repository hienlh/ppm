import { useCallback, useRef, useState } from "react";
import { ClipboardPaste, Undo2, Redo2, X } from "lucide-react";
import type * as MonacoType from "monaco-editor";

/** Clipboard API requires secure context (HTTPS / localhost) */
const isSecureContext = typeof window !== "undefined" && window.isSecureContext;

/** Symbols commonly needed when coding on mobile — ordered by frequency */
const SYMBOL_KEYS = [
  "(", ")", "{", "}", "[", "]",
  "<", ">", ";", ":", "=",
  '"', "'", "`", "/", "\\", "_", "#",
];

const btnBase =
  "px-2 py-1.5 rounded text-xs min-w-[36px] min-h-[32px] bg-surface-elevated text-text-primary active:bg-primary active:text-primary-foreground transition-colors select-none";
const btnSymbol =
  "px-3 py-1.5 rounded text-xs font-mono min-w-[36px] min-h-[32px] bg-surface-elevated text-text-primary active:bg-primary active:text-primary-foreground transition-colors select-none";
const divider = "w-px h-5 bg-border mx-0.5 shrink-0";

interface EditorMobileToolbarProps {
  editorRef: React.RefObject<MonacoType.editor.IStandaloneCodeEditor | null>;
  readOnly?: boolean;
}

export function EditorMobileToolbar({ editorRef, readOnly }: EditorMobileToolbarProps) {
  const getEditor = useCallback(() => editorRef.current, [editorRef]);

  /** Insert text at cursor position in Monaco */
  const insertText = useCallback((text: string) => {
    const editor = getEditor();
    if (!editor) return;
    editor.focus();
    const selection = editor.getSelection();
    if (selection) {
      editor.executeEdits("mobile-toolbar", [{ range: selection, text }]);
    }
  }, [getEditor]);

  // --- Paste: two strategies based on secure context ---
  const [pasteMode, setPasteMode] = useState(false);
  const pasteRef = useRef<HTMLTextAreaElement | null>(null);

  // HTTPS: use Clipboard API directly (single tap)
  const handleClipboardPaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) insertText(text);
    } catch { /* permission denied */ }
  }, [insertText]);

  // HTTP fallback: show textarea for native long-press paste
  const openPasteMode = useCallback(() => {
    setPasteMode(true);
    requestAnimationFrame(() => pasteRef.current?.focus());
  }, []);

  const handleNativePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    setPasteMode(false);
    insertText(text);
  }, [insertText]);

  const handleUndo = useCallback(() => {
    const editor = getEditor();
    if (!editor) return;
    editor.focus();
    editor.trigger("mobile-toolbar", "undo", null);
  }, [getEditor]);

  const handleRedo = useCallback(() => {
    const editor = getEditor();
    if (!editor) return;
    editor.focus();
    editor.trigger("mobile-toolbar", "redo", null);
  }, [getEditor]);

  const handleTab = useCallback(() => {
    const editor = getEditor();
    if (!editor) return;
    editor.focus();
    editor.trigger("mobile-toolbar", "tab", null);
  }, [getEditor]);

  if (readOnly) return null;

  return (
    <div className="shrink-0 border-t border-border bg-surface">
      {/* HTTP-only: textarea for native paste via long-press */}
      {!isSecureContext && pasteMode && (
        <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border bg-muted/50">
          <textarea
            ref={pasteRef}
            onPaste={handleNativePaste}
            placeholder="Long-press here → Paste"
            className="flex-1 h-8 rounded border border-border bg-background text-foreground text-xs px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            type="button"
            onClick={() => setPasteMode(false)}
            className="p-1.5 rounded text-muted-foreground active:bg-muted transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Toolbar buttons */}
      <div className="flex items-center gap-1 px-2 py-1.5 overflow-x-auto">
        {/* Paste: Clipboard API on HTTPS, textarea fallback on HTTP */}
        <button
          type="button"
          onClick={isSecureContext ? handleClipboardPaste : openPasteMode}
          className={btnBase}
          title="Paste"
        >
          <ClipboardPaste size={14} />
        </button>
        <button type="button" onClick={handleUndo} className={btnBase} title="Undo">
          <Undo2 size={14} />
        </button>
        <button type="button" onClick={handleRedo} className={btnBase} title="Redo">
          <Redo2 size={14} />
        </button>

        <div className={divider} />

        <button type="button" onClick={handleTab} className={btnSymbol}>
          Tab
        </button>

        <div className={divider} />

        {SYMBOL_KEYS.map((key) => (
          <button key={key} type="button" onClick={() => insertText(key)} className={btnSymbol}>
            {key}
          </button>
        ))}
      </div>
    </div>
  );
}
