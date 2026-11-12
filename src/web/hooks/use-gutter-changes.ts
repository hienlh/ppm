/**
 * VS Code's change bars: the editor's line-number gutter marks every line that
 * differs from the file in git's index — green for added, blue for modified, a
 * red wedge where lines were deleted — with the same marks in the scrollbar.
 *
 * The index, as VS Code does, so the bars mean "not staged yet": staging or
 * committing a change clears its bar. An untracked file has nothing to compare
 * with and gets no bars, rather than every line green.
 *
 * The diff runs in the browser against the live buffer, so the bars follow
 * typing (after a short pause) and do not wait for a save. Only the base comes
 * from the server, and it is asked again whenever it may have moved:
 * - at once on `git:changed`, i.e. a stage, commit or discard made through PPM;
 * - every few seconds while this editor is on screen, for what nothing reports —
 *   a `git add` in a terminal, or the AI committing from its own shell. Each of
 *   those asks names the blob already held, so an unchanged index costs one
 *   `git ls-files` and returns no content;
 * - when the editor comes back into view, gets focus, or the page is shown again.
 * A tab parked off-screen (`tab-pool` keeps editors mounted) asks for nothing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type * as MonacoType from "monaco-editor";
import { api } from "@/lib/api-client";
import { computeGutterChanges, splitBaseLines, type GutterChange, type GutterChangeKind } from "@/lib/gutter-changes";
import { useGitRepo } from "@/hooks/use-git-repo";
import { THEME_CHANGE_EVENT } from "@/theme/apply-theme";
import type { IndexBase } from "../../shared/git-index-base";

/** How often an on-screen editor checks whether the index moved under it. */
export const GUTTER_POLL_MS = 5000;
/** How long after `git:changed` the base is read, so a burst of writes costs one read. */
const CHANGED_DELAY_MS = 300;
/** Pause in typing before the bars are redrawn. */
const REDRAW_DELAY_MS = 150;
/** Past this the buffer is not diffed on every pause in typing. */
const MAX_LINES = 100_000;

const STYLE_ID = "gutter-change-styles";
// Drawn in Monaco's line-decorations column, between the line numbers and the
// text, as a pseudo-element of the `.cldr` box Monaco positions per line — so a
// bar needs no width of its own and never moves the code.
const CSS = `
  .monaco-editor .ppm-gutter-change::before {
    content: "";
    position: absolute;
    left: 2px;
    pointer-events: none;
  }
  .monaco-editor .ppm-gutter-added::before,
  .monaco-editor .ppm-gutter-modified::before {
    top: 0;
    width: 3px;
    height: 100%;
  }
  .monaco-editor .ppm-gutter-added::before { background: var(--success); }
  .monaco-editor .ppm-gutter-modified::before { background: var(--info); }
  /* A wedge on the boundary the deleted lines sat on: below the line they
     followed, or above line 1 when they were the first lines of the file. */
  .monaco-editor .ppm-gutter-deleted::before {
    bottom: -4px;
    z-index: 1;
    width: 0;
    height: 0;
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
    border-left: 5px solid var(--error);
  }
  .monaco-editor .ppm-gutter-deleted-top::before {
    top: 0;
    bottom: auto;
    border-top: 0;
  }
`;

function injectStyles(editor: MonacoType.editor.ICodeEditor): void {
  // The editor can live in a picture-in-picture window, which has a head of its own.
  const doc = editor.getDomNode()?.ownerDocument ?? document;
  if (doc.getElementById(STYLE_ID)) return;
  const el = doc.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  doc.head?.appendChild(el);
}

/** The theme tokens each kind is drawn in; CSS reads them directly, the scrollbar needs them resolved. */
const KIND_TOKEN: Record<GutterChangeKind, string> = {
  added: "--success",
  modified: "--info",
  deleted: "--error",
};

function rulerColors(): Record<GutterChangeKind, string> {
  const style = getComputedStyle(document.documentElement);
  const read = (token: string, fallback: string) => style.getPropertyValue(token).trim() || fallback;
  return {
    added: read(KIND_TOKEN.added, "#34d399"),
    modified: read(KIND_TOKEN.modified, "#38bdf8"),
    deleted: read(KIND_TOKEN.deleted, "#f87171"),
  };
}

/** Is the editor actually on screen, rather than parked in `tab-pool`'s hidden container? */
function onScreen(editor: MonacoType.editor.ICodeEditor): boolean {
  if (document.visibilityState !== "visible") return false;
  const node = editor.getDomNode();
  if (!node?.isConnected) return false;
  // The parking container is `visibility: hidden`, which only checkVisibility sees.
  if (typeof node.checkVisibility === "function") return node.checkVisibility({ visibilityProperty: true });
  return node.getClientRects().length > 0;
}

export function toDecorations(
  monaco: typeof MonacoType,
  model: MonacoType.editor.ITextModel,
  changes: GutterChange[],
  colors: Record<GutterChangeKind, string>,
): MonacoType.editor.IModelDeltaDecoration[] {
  const lineCount = model.getLineCount();
  const decorations: MonacoType.editor.IModelDeltaDecoration[] = [];
  for (const change of changes) {
    const top = change.kind === "deleted" && change.startLine === 0;
    const start = Math.min(Math.max(change.startLine, 1), lineCount);
    const end = Math.min(Math.max(change.endLine, 1), lineCount);
    const column = change.kind === "deleted" ? model.getLineMaxColumn(start) : 1;
    decorations.push({
      range: change.kind === "deleted"
        ? new monaco.Range(start, column, start, column)
        : new monaco.Range(start, 1, end, 1),
      options: {
        isWholeLine: change.kind !== "deleted",
        linesDecorationsClassName: `ppm-gutter-change ppm-gutter-${change.kind}${top ? " ppm-gutter-deleted-top" : ""}`,
        overviewRuler: { color: colors[change.kind], position: monaco.editor.OverviewRulerLane.Left },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    });
  }
  return decorations;
}

export interface UseGutterChangesOptions {
  editor: MonacoType.editor.ICodeEditor | null;
  monaco: typeof MonacoType | null;
  projectName?: string;
  /** Project-relative, as the tab holds it. */
  filePath?: string;
  enabled: boolean;
}

interface HeldBase {
  url: string;
  oid: string | null;
  /** Null when there is nothing to compare with (untracked, binary, …). */
  lines: string[] | null;
}

export function useGutterChanges({ editor, monaco, projectName, filePath, enabled }: UseGutterChangesOptions): void {
  // The repository that holds this file, not the one Source Control has picked
  // — the same rule as the inline blame (see `use-inline-blame.ts`).
  const { fileScope, fileGitUrl } = useGitRepo(enabled ? projectName : undefined);
  const scope = enabled && filePath ? fileScope(filePath) : null;
  const repoFile = scope?.path ?? null;
  const fileRepo = scope?.repo ?? null;
  const baseUrl = enabled && projectName && repoFile != null
    ? fileGitUrl(`/index-base?${new URLSearchParams({ path: repoFile })}`, fileRepo)
    : null;

  const baseRef = useRef<HeldBase | null>(null);
  const [baseVersion, setBaseVersion] = useState(0);
  const requestRef = useRef(0);
  const inFlightRef = useRef(false);

  const revalidate = useCallback(async () => {
    if (!baseUrl || inFlightRef.current) return;
    const held = baseRef.current?.url === baseUrl ? baseRef.current : null;
    const url = held?.oid ? `${baseUrl}&known=${encodeURIComponent(held.oid)}` : baseUrl;
    const id = ++requestRef.current;
    inFlightRef.current = true;
    try {
      const answer = await api.get<IndexBase>(url);
      if (id !== requestRef.current || answer.state === "same") return;
      baseRef.current = {
        url: baseUrl,
        oid: answer.oid ?? null,
        lines: answer.state === "ok" ? splitBaseLines(answer.content) : null,
      };
      setBaseVersion((v) => v + 1);
    } catch {
      // A failed check keeps the bars that were drawn; with none drawn yet there is nothing to keep.
      if (id === requestRef.current && !held) {
        baseRef.current = { url: baseUrl, oid: null, lines: null };
        setBaseVersion((v) => v + 1);
      }
    } finally {
      if (id === requestRef.current) inFlightRef.current = false;
    }
  }, [baseUrl]);

  // A new file, repository or switch: drop the old base and read this one.
  useEffect(() => {
    requestRef.current++;
    inFlightRef.current = false;
    baseRef.current = null;
    setBaseVersion((v) => v + 1);
    void revalidate();
  }, [revalidate]);

  // Read it again whenever the index may have moved.
  useEffect(() => {
    if (!baseUrl || !editor) return;
    const check = () => { if (onScreen(editor)) void revalidate(); };
    const poll = setInterval(check, GUTTER_POLL_MS);

    let soon: ReturnType<typeof setTimeout> | undefined;
    const onGitChanged = (e: Event) => {
      if ((e as CustomEvent<{ projectName?: string }>).detail?.projectName !== projectName) return;
      clearTimeout(soon);
      soon = setTimeout(check, CHANGED_DELAY_MS);
    };
    window.addEventListener("git:changed", onGitChanged);
    document.addEventListener("visibilitychange", check);
    const focus = editor.onDidFocusEditorText(check);

    // Back from `tab-pool`'s parking spot: check now rather than at the next tick.
    const node = editor.getDomNode();
    const observer = node && typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) check(); })
      : null;
    if (node) observer?.observe(node);

    return () => {
      clearInterval(poll);
      clearTimeout(soon);
      window.removeEventListener("git:changed", onGitChanged);
      document.removeEventListener("visibilitychange", check);
      focus.dispose();
      observer?.disconnect();
    };
  }, [baseUrl, editor, projectName, revalidate]);

  // Draw, and redraw as the buffer changes.
  useEffect(() => {
    if (!editor || !monaco) return;
    const collection = editor.createDecorationsCollection();
    let colors = rulerColors();

    const draw = () => {
      const model = editor.getModel();
      const base = baseRef.current;
      if (!model || !base?.lines || base.url !== baseUrl || model.getLineCount() > MAX_LINES) {
        collection.clear();
        return;
      }
      injectStyles(editor);
      const changes = computeGutterChanges(base.lines, model.getLinesContent());
      collection.set(toDecorations(monaco, model, changes, colors));
    };
    draw();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(draw, REDRAW_DELAY_MS);
    };
    const edits = editor.onDidChangeModelContent(later);
    const swapped = editor.onDidChangeModel(draw);
    // The scrollbar marks are painted in resolved colours, so a theme change repaints them.
    const onTheme = () => { colors = rulerColors(); draw(); };
    window.addEventListener(THEME_CHANGE_EVENT, onTheme);

    return () => {
      clearTimeout(timer);
      edits.dispose();
      swapped.dispose();
      window.removeEventListener(THEME_CHANGE_EVENT, onTheme);
      collection.clear();
    };
  }, [editor, monaco, baseUrl, baseVersion]);
}
