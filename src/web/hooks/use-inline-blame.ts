/**
 * GitLens-style inline blame: the cursor's line gets a dimmed annotation after
 * its text saying who last touched it, when, and why.
 *
 * The whole file is blamed once and indexed by line, because re-running git on
 * every cursor move would be a process per keystroke. The flip side is that the
 * mapping goes stale the moment the buffer is edited — line 40 is no longer the
 * line git blamed — so the annotation hides itself until the file is saved and
 * the blame refetched, rather than confidently attributing the wrong commit.
 *
 * The same hook drives both panes of the diff viewer, where each side is the file
 * at a different revision (`rev`) and the buffer is read-only. Pass
 * `readOnly: true` there: a read-only buffer whose content changes is the host
 * swapping revisions, not a user edit, and treating it as one would hide the
 * annotation for good.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type * as MonacoType from "monaco-editor";
import { api, projectUrl } from "@/lib/api-client";
import { formatBlameAnnotation, type BlameResult } from "../../shared/blame";

const STYLE_ID = "inline-blame-styles";
// Monaco renders injected text as a real span carrying `inlineClassName`, so
// the class is styled directly rather than through a ::after pseudo-element.
const CSS = `
  .inline-blame-annotation {
    color: var(--color-muted-foreground);
    opacity: 0.6;
    font-style: italic;
    white-space: pre;
  }
`;

function injectStyles(editor: MonacoType.editor.ICodeEditor): void {
  // The editor can live inside a picture-in-picture document, which has its own
  // head — take the style to wherever the editor actually is.
  const doc = editor.getDomNode()?.ownerDocument ?? document;
  if (doc.getElementById(STYLE_ID)) return;
  const el = doc.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  doc.head?.appendChild(el);
}

export interface UseInlineBlameOptions {
  /**
   * Any code editor — `IStandaloneCodeEditor` from the normal editor, or one
   * side of a diff editor, which is the narrower `ICodeEditor`.
   */
  editor: MonacoType.editor.ICodeEditor | null;
  monaco: typeof MonacoType | null;
  projectName?: string;
  filePath?: string;
  /** Blame the file as of this revision; omitted means the working tree. */
  rev?: string;
  enabled: boolean;
  /** The buffer cannot be edited by the user — skip staleness tracking. */
  readOnly?: boolean;
}

export interface InlineBlameState {
  /** True after an edit, until the file is saved and the blame refetched. */
  stale: boolean;
  /** Re-run the blame — call after a save. */
  refresh: () => void;
}

export function useInlineBlame({
  editor,
  monaco,
  projectName,
  filePath,
  rev,
  enabled,
  readOnly = false,
}: UseInlineBlameOptions): InlineBlameState {
  const [blame, setBlame] = useState<BlameResult | null>(null);
  const [stale, setStale] = useState(false);
  const [line, setLine] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const decorationsRef = useRef<MonacoType.editor.IEditorDecorationsCollection | null>(null);

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  // Load the blame. A file with no git history answers with an empty table
  // rather than an error, so there is nothing to special-case here.
  useEffect(() => {
    if (!enabled || !projectName || !filePath) {
      setBlame(null);
      return;
    }
    let cancelled = false;
    const query = new URLSearchParams({ path: filePath });
    if (rev) query.set("rev", rev);
    api
      .get<BlameResult>(`${projectUrl(projectName)}/git/blame?${query}`)
      .then((result) => {
        if (cancelled) return;
        setBlame(result);
        setStale(false);
      })
      .catch(() => {
        // Not in a repo, or the file is untracked — no annotation, no error.
        if (!cancelled) setBlame(null);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, projectName, filePath, rev, reloadToken]);

  // Follow the cursor, and notice edits.
  useEffect(() => {
    if (!editor || !enabled) return;
    setLine(editor.getPosition()?.lineNumber ?? 0);
    const cursor = editor.onDidChangeCursorPosition((e) => setLine(e.position.lineNumber));
    if (readOnly) return () => cursor.dispose();

    const edits = editor.onDidChangeModelContent(() => setStale(true));
    return () => {
      cursor.dispose();
      edits.dispose();
    };
  }, [editor, enabled, readOnly]);

  const commit = (() => {
    if (!blame || stale || line <= 0) return null;
    const entry = blame.lines[line - 1];
    // The table is dense and in order, but a defensive lookup costs nothing and
    // keeps a short blame from mis-attributing a line past its end.
    const hash = entry?.finalLine === line ? entry.hash : blame.lines.find((l) => l.finalLine === line)?.hash;
    return hash ? (blame.commits[hash] ?? null) : null;
  })();

  // Draw it.
  useEffect(() => {
    if (!editor || !monaco) return;
    if (!enabled || !commit || line <= 0) {
      decorationsRef.current?.clear();
      return;
    }
    injectStyles(editor);

    const model = editor.getModel();
    if (!model || line > model.getLineCount()) {
      decorationsRef.current?.clear();
      return;
    }
    const column = model.getLineMaxColumn(line);
    const text = formatBlameAnnotation(commit);

    const decoration: MonacoType.editor.IModelDeltaDecoration = {
      range: new monaco.Range(line, column, line, column),
      options: {
        // `after` injects text that is not part of the model, so it never
        // reaches the file and never shifts a column the user can select.
        after: { content: `    ${text}`, inlineClassName: "inline-blame-annotation" },
        showIfCollapsed: true,
      },
    };

    if (decorationsRef.current) decorationsRef.current.set([decoration]);
    else decorationsRef.current = editor.createDecorationsCollection([decoration]);
  }, [editor, monaco, enabled, commit, line]);

  // Take the annotation down when the hook stops being used.
  useEffect(
    () => () => {
      decorationsRef.current?.clear();
      decorationsRef.current = null;
    },
    [],
  );

  return { stale, refresh };
}
