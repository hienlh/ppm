/**
 * The Review changes tab side by side: the focused file whole, HEAD on the left
 * and the working tree on the right, in VS Code's own diff editor (Monaco) —
 * unchanged stretches folded, words that changed highlighted — with each
 * block's bar (Stage / Discard / Unstage / Undo) drawn above its lines.
 *
 * HEAD on the left rather than the index, so a staged block stays on screen
 * with its Unstage, as it does in the block list. The bars are Monaco view
 * zones in the right-hand editor, which the diff editor aligns on the left;
 * React renders into them through portals, so they are the same component and
 * the same actions as the block list's, and J/K/Y/N reach them unchanged.
 *
 * Picking single lines is the block list's (the desktop shows it while a pick
 * is open), and a file the list shows as one whole-file block — binary, a
 * rename, a submodule — stays in the list: there are no lines to put side by side.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type * as MonacoType from "monaco-editor";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { Loader2 } from "@/lib/icons";
import { useGitRepo } from "@/hooks/use-git-repo";
import { useMonacoTheme } from "@/lib/use-monaco-theme";
import { useSettingsStore } from "@/stores/settings-store";
import { prepareMonacoTheme } from "@/theme/adapters/monaco-adapter";
import { registerDotenvLanguage } from "@/lib/monaco-dotenv-language";
import { EDITOR_FONT_FAMILY, EDITOR_FONT_LIGATURES, EDITOR_FONT_SIZE } from "@/lib/editor-font";
import { fileSignature } from "@/lib/git-review-model";
import { blockAtLine, placeBlocks } from "@/lib/git-review-side-by-side";
import { DiffEditor, getMonacoLanguage } from "@/components/editor/monaco-diff-editor";
import type { FileFullDiff } from "../../../types/git";
import { ReviewBlockBar, type BlockActions } from "./git-review-block";
import type { GitReviewView } from "./git-review-tab";

/** A bar's height: one row of the block list's bar, so the two read alike. */
const BAR_HEIGHT = 38;

/**
 * Monaco paints its lines layer over the view zones layer, so a zone gets no
 * clicks however it is styled inside. Positioned with a z-index, the zone joins
 * the layer above the lines: its buttons take the pointer, and the hidden-lines
 * handles Monaco draws as overlay widgets stay above it.
 */
const ZONE_CSS = ".monaco-editor .view-zones > .ppm-review-zone { z-index: 1; }";

type Panes = { diff: MonacoType.editor.IStandaloneDiffEditor; monaco: typeof MonacoType };

export function ReviewSideBySide({ view, actions }: { view: GitReviewView; actions: { current: BlockActions } }) {
  const { review } = view;
  const focused = review.focused!;
  const file = focused.review;
  const { gitUrl } = useGitRepo(view.projectName);
  const monacoTheme = useMonacoTheme();
  const wordWrap = useSettingsStore((s) => s.wordWrap);

  // The file as HEAD has it and as it is on disk. Read again whenever git's
  // answer for the file changes — a discard or an Undo rewrites the working
  // tree, and so does anyone editing it while the tab is open.
  const signature = file.file ? fileSignature(file.file) : "";
  const [content, setContent] = useState<{ path: string; diff: FileFullDiff } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .get<FileFullDiff>(gitUrl(`/file-full-diff?file=${encodeURIComponent(file.path)}&ref=HEAD`))
      .then((diff) => { if (!cancelled) setContent({ path: file.path, diff }); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Could not read the file"); });
    return () => { cancelled = true; };
  }, [gitUrl, file.path, signature]);

  const [panes, setPanes] = useState<Panes | null>(null);
  const blocks = file.blocks;
  const places = useMemo(() => placeBlocks(blocks), [blocks]);

  // One view zone per block, above its first changed line. Rebuilt only when a
  // block moves or the set changes; what a bar says is re-rendered into it.
  const layout = places.map((p) => `${p.key}@${p.line}`).join(",");
  const [zones, setZones] = useState<ReadonlyMap<string, HTMLElement>>(new Map());
  const ready = !!panes && content?.path === file.path;
  useEffect(() => {
    if (!panes || !ready) return;
    const modified = panes.diff.getModifiedEditor();
    const made = new Map<string, HTMLElement>();
    const ids: string[] = [];
    modified.changeViewZones((acc) => {
      places.forEach((place, ordinal) => {
        const dom = document.createElement("div");
        dom.className = "ppm-review-zone";
        dom.dataset.blockKey = place.key;
        // Monaco listens on an ancestor and captures the pointer on the way down, so the
        // button under it never gets its mouseup or click (`suppressMouseDown` does not stop
        // that). Stopped here, natively: React's own handlers sit above Monaco and run too late.
        for (const type of ["pointerdown", "mousedown"]) dom.addEventListener(type, (e) => e.stopPropagation());
        ids.push(acc.addZone({
          afterLineNumber: Math.max(0, place.line - 1),
          heightInPx: BAR_HEIGHT,
          domNode: dom,
          ordinal,
          // The bar's buttons take their own clicks; Monaco would otherwise move the cursor.
          suppressMouseDown: true,
        }));
        made.set(place.key, dom);
      });
    });
    setZones(made);
    return () => {
      modified.changeViewZones((acc) => { for (const id of ids) acc.removeZone(id); });
    };
    // `places` is read through `layout`, which changes exactly when a zone has to move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panes, ready, layout]);

  // J/K and an answer move the focus: bring its bar into view, as the list scrolls to its block.
  const focusKey = focused.block.key;
  const placesRef = useRef(places);
  placesRef.current = places;
  useEffect(() => {
    if (!panes || !ready) return;
    const place = placesRef.current.find((p) => p.key === focusKey);
    if (!place) return;
    const modified = panes.diff.getModifiedEditor();
    const top = modified.getTopForLineNumber(Math.max(1, place.line)) - BAR_HEIGHT;
    const visible = modified.getScrollTop();
    const height = modified.getLayoutInfo().height;
    if (top < visible || top + BAR_HEIGHT * 2 > visible + height) modified.setScrollTop(Math.max(0, top - height / 3));
  }, [panes, ready, focusKey, layout]);

  // A view zone is as wide as the longest line and scrolls sideways with the code, so the
  // bar is held to the width on screen and moved back by the sideways scroll: its buttons
  // stay at the right edge of what is visible, as the block list's do.
  const [frame, setFrame] = useState({ width: 0, left: 0 });
  useEffect(() => {
    if (!panes) return;
    const modified = panes.diff.getModifiedEditor();
    const update = () => setFrame({ width: modified.getLayoutInfo().contentWidth, left: modified.getScrollLeft() });
    update();
    const layoutSub = modified.onDidLayoutChange(update);
    const scrollSub = modified.onDidScrollChange((e) => { if (e.scrollLeftChanged) update(); });
    return () => { layoutSub.dispose(); scrollSub.dispose(); };
  }, [panes]);

  // A click in the code focuses the block it belongs to, as a click on a card does.
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  useEffect(() => {
    if (!panes) return;
    const sub = panes.diff.getModifiedEditor().onMouseDown((e) => {
      const line = e.target.position?.lineNumber;
      if (!line) return;
      const key = blockAtLine(blocksRef.current, placesRef.current, line);
      if (key) actions.current.focus(key);
    });
    return () => sub.dispose();
  }, [panes, actions]);

  const busy = !!review.busy;
  return (
    <div data-review-diff className="relative min-h-0 flex-1 bg-bg">
      <style>{ZONE_CSS}</style>
      {error ? (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">{error}</div>
      ) : !ready && !content ? (
        <div className="flex h-full items-center justify-center gap-2 text-text-3">
          <Loader2 className="size-5 animate-spin" />
          <span className="text-sm">Reading the file…</span>
        </div>
      ) : content ? (
        <div className="absolute inset-0">
          <DiffEditor
            height="100%"
            language={getMonacoLanguage(file.path)}
            original={content.diff.original}
            modified={content.diff.modified}
            theme={monacoTheme}
            beforeMount={(monaco) => {
              prepareMonacoTheme(monaco);
              registerDotenvLanguage(monaco);
            }}
            onMount={(diff, monaco) => setPanes({ diff, monaco: monaco as typeof MonacoType })}
            options={{
              readOnly: true,
              originalEditable: false,
              renderSideBySide: true,
              // A narrow tab is the user's to switch to inline: the bars live on the right side.
              useInlineViewWhenSpaceIsLimited: false,
              // VS Code's "collapse unchanged regions": the file whole, but only the changes open.
              hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 20 },
              diffWordWrap: wordWrap ? "on" : "off",
              fontSize: EDITOR_FONT_SIZE,
              fontFamily: EDITOR_FONT_FAMILY,
              fontLigatures: EDITOR_FONT_LIGATURES,
              automaticLayout: true,
              scrollBeyondLastLine: false,
              renderOverviewRuler: true,
            }}
            loading={<Loader2 className="size-5 animate-spin text-text-3" />}
          />
        </div>
      ) : null}
      {ready && blocks.map((block, index) => {
        const dom = zones.get(block.key);
        if (!dom) return null;
        const isFocused = block.key === focusKey;
        return createPortal(
          <div
            data-block-key={block.key}
            data-state={block.state}
            data-focused={isFocused || undefined}
            style={frame.width ? { width: frame.width, transform: "translateX(" + frame.left + "px)" } : undefined}
            onClick={(e) => {
              if (!isFocused && !(e.target as HTMLElement).closest("button")) actions.current.focus(block.key);
            }}
            className={cn(
              // One row whatever the width: the labels give way (cut short), the buttons never do.
              "flex h-full cursor-default items-center gap-x-2 overflow-hidden whitespace-nowrap border-y py-1 pr-1.5 pl-3 font-sans text-xs leading-[1.3] text-text-3",
              "[&>span]:min-w-0 [&>span]:truncate [&>button]:shrink-0",
              block.state === "staged" ? "border-dashed border-primary/45 bg-panel" : block.state === "discarded" ? "border-dashed border-border-soft bg-panel" : "border-border-soft bg-panel",
              isFocused && "border-primary/60 bg-[color-mix(in_srgb,var(--accent)_7%,var(--panel))] shadow-[inset_3px_0_0_var(--accent)]",
            )}
          >
            <ReviewBlockBar
              block={block}
              index={index}
              total={blocks.length}
              focused={isFocused}
              pick={null}
              compact={false}
              busy={busy}
              actions={actions}
            />
          </div>,
          dom,
          block.key,
        );
      })}
    </div>
  );
}
