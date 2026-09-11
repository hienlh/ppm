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
import { api } from "@/lib/api-client";
import {
  formatBlameAnnotation,
  isUncommittedHash,
  type BlameCommitInfo,
  type BlameLineDetail,
  type BlameResult,
} from "../../shared/blame";
import { buildBlameHoverMarkdown } from "@/lib/blame-hover";
import { registerBlameHoverCommands } from "@/lib/blame-hover-commands";
import { registerDiffLanguage } from "@/lib/monaco-diff-language";
import { useGitRepo } from "@/hooks/use-git-repo";
import { useProjectStore } from "@/stores/project-store";

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
  /* The hover's avatar is a markdown image, so it sits on the text baseline and
     hangs below the author name without this. */
  .monaco-hover img {
    vertical-align: text-bottom;
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
  // Keyed, not bare: two adjacent lines can share a commit, and a detail
  // matched on the hash alone would show the previous line's diff on the next
  // one while the new request is still in flight.
  const [detail, setDetail] = useState<{ key: string; value: BlameLineDetail | null } | null>(null);
  const detailCache = useRef(new Map<string, BlameLineDetail | null>());
  const decorationsRef = useRef<MonacoType.editor.IEditorDecorationsCollection | null>(null);
  // The line the annotation is actually drawn on, for the touch handler to
  // compare a tap against. A ref rather than the `line` state so the handler
  // does not have to be torn down and rebuilt on every cursor move.
  const annotatedLineRef = useRef(0);
  // The hover's action links address the Git Graph views by absolute path,
  // which is what those commands take. Looked up here rather than passed in, so
  // the three call sites do not each have to find it.
  const projectPath = useProjectStore((s) => s.projects.find((p) => p.name === projectName)?.path);
  // Which repository the project's git actually lives in: itself, or a subfolder
  // the user picked. Every path below is expressed relative to *that*, because
  // that is where git runs.
  const gitRepo = useGitRepo(projectName);
  const gitRoot = gitRepo.repo?.path ?? projectPath;
  // `null` means the open file is outside the chosen repository — there is
  // nothing to blame, which is a quiet no-annotation rather than an error.
  const repoFile = filePath ? gitRepo.repoPath(filePath) : null;

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  // Both are global to the page and idempotent. Registered here rather than at
  // module load because both need a Monaco instance: the `diff` language is
  // what colours the hover's diff block, and the commands are what its buttons
  // reach.
  useEffect(() => {
    if (!monaco || !enabled) return;
    registerDiffLanguage(monaco);
    registerBlameHoverCommands(monaco);
  }, [monaco, enabled]);

  // Load the blame. A file with no git history answers with an empty table
  // rather than an error, so there is nothing to special-case here.
  useEffect(() => {
    if (!enabled || !projectName || !filePath || repoFile == null) {
      setBlame(null);
      return;
    }
    let cancelled = false;
    const query = new URLSearchParams({ path: repoFile });
    if (rev) query.set("rev", rev);
    api
      .get<BlameResult>(gitRepo.gitUrl(`/blame?${query}`))
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
  }, [enabled, projectName, filePath, repoFile, rev, reloadToken, gitRepo]);

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

  // A tap where a touch device has no hover.
  //
  // The project's mobile rules forbid a hover-only interaction, and a phone has
  // no hover at all — so on a device that reports `hover: none`, a tap on the
  // annotation opens the same hover that a mouse would. `editor.action.showHover`
  // opens it at the cursor, which the tap has already moved onto the line.
  //
  // The tap is identified by position rather than by the mouse target's
  // `injectedText`, which says so exactly but is not in Monaco's public
  // typings: the annotation sits after the line's last column, so a tap at or
  // past that column on the annotated line is a tap on it. Being a little
  // generous about the column is the right way round here — it makes the target
  // the whole end of the line rather than a 19px strip of italic text.
  useEffect(() => {
    if (!editor || !enabled) return;
    // `hover: none` rather than a width breakpoint: the question is whether this
    // pointer can hover at all, not how wide the screen is.
    if (!window.matchMedia?.("(hover: none)").matches) return;

    const sub = editor.onMouseDown((e) => {
      const position = e.target.position;
      const model = editor.getModel();
      if (!position || !model) return;
      if (position.lineNumber !== annotatedLineRef.current) return;
      if (position.column < model.getLineMaxColumn(position.lineNumber)) return;
      editor.getAction("editor.action.showHover")?.run();
    });
    return () => sub.dispose();
  }, [editor, enabled]);

  const lineBlame: { commit: BlameCommitInfo; origLine: number } | null = (() => {
    if (!blame || stale || line <= 0) return null;
    const dense = blame.lines[line - 1];
    // The table is dense and in order, but a defensive lookup costs nothing and
    // keeps a short blame from mis-attributing a line past its end.
    const entry = dense?.finalLine === line ? dense : blame.lines.find((l) => l.finalLine === line);
    if (!entry) return null;
    const commit = blame.commits[entry.hash];
    return commit ? { commit, origLine: entry.origLine } : null;
  })();
  const commit = lineBlame?.commit ?? null;

  // What the hover needs beyond the annotation: the whole commit message and
  // the change this commit made to this line. One `git show` per commit *and
  // line*, so the key covers both — moving down a line inside the same commit
  // is a different diff.
  //
  // Deliberately not fetched lazily when the hover opens: Monaco reads
  // `hoverMessage` off the decoration synchronously, so a hover has whatever is
  // ready at that moment. Fetching as the cursor moves is what makes it appear
  // filled in instead of behind a spinner — which is the failure this editor
  // already had once, with the bundled TypeScript worker.
  const detailHash = commit && !isUncommittedHash(commit.hash) ? commit.hash : null;
  // The path *at that commit*: after a rename the current path did not exist
  // there, and git would report no diff rather than an error. `filename` comes
  // from the blame git already ran, so it is repository-relative like
  // `repoFile` — not project-relative like the tab's `filePath`.
  const detailPath = commit?.filename || repoFile || undefined;
  const detailLine = lineBlame?.origLine ?? 0;
  const detailKey = `${detailHash} ${detailLine} ${detailPath}`;

  useEffect(() => {
    if (!enabled || !projectName || !detailHash || !detailPath || detailLine < 1) {
      setDetail(null);
      return;
    }
    const key = detailKey;
    const cache = detailCache.current;
    // `has`, not a truthy check: a commit with nothing to show caches as null
    // and must not be refetched on every return to the line.
    if (cache.has(key)) {
      setDetail({ key, value: cache.get(key) ?? null });
      return;
    }

    let cancelled = false;
    const query = new URLSearchParams({ hash: detailHash, path: detailPath, line: String(detailLine) });
    api
      .get<BlameLineDetail | null>(gitRepo.gitUrl(`/commit-line?${query}`))
      .then((result) => {
        if (cancelled) return;
        // Bounded: `tab-pool` keeps editors mounted for the life of the session,
        // so an unbounded cache here is a leak that grows with every line the
        // cursor has ever rested on.
        if (cache.size >= 200) cache.delete(cache.keys().next().value as string);
        cache.set(key, result ?? null);
        setDetail({ key, value: result ?? null });
      })
      .catch(() => {
        // No detail is a smaller hover, not an error worth showing.
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, projectName, detailHash, detailPath, detailLine, detailKey, gitRepo]);

  // Draw it.
  useEffect(() => {
    if (!editor || !monaco) return;
    if (!enabled || !commit || line <= 0) {
      annotatedLineRef.current = 0;
      decorationsRef.current?.clear();
      return;
    }
    injectStyles(editor);

    const model = editor.getModel();
    if (!model || line > model.getLineCount()) {
      annotatedLineRef.current = 0;
      decorationsRef.current?.clear();
      return;
    }
    annotatedLineRef.current = line;
    const column = model.getLineMaxColumn(line);
    const text = formatBlameAnnotation(commit);

    const decoration: MonacoType.editor.IModelDeltaDecoration = {
      range: new monaco.Range(line, column, line, column),
      options: {
        // `after` injects text that is not part of the model, so it never
        // reaches the file and never shifts a column the user can select.
        after: { content: `    ${text}`, inlineClassName: "inline-blame-annotation" },
        // Hovering injected text does reach a collapsed decoration: Monaco
        // relaxes its column check by one character for `showIfCollapsed`, and
        // the injected span resolves to the line's last column. Verified
        // against Monaco 0.55.1 rather than assumed, because the whole hover
        // hangs off it.
        showIfCollapsed: true,
        // Null for an uncommitted line, which the annotation already explains.
        hoverMessage: buildBlameHoverMarkdown({
          commit,
          detail: detail?.key === detailKey ? detail.value : null,
          filePath: repoFile ?? "",
          projectPath: gitRoot,
        }),
      },
    };

    if (decorationsRef.current) decorationsRef.current.set([decoration]);
    else decorationsRef.current = editor.createDecorationsCollection([decoration]);
  }, [editor, monaco, enabled, commit, line, detail, detailKey, repoFile, gitRoot]);

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
