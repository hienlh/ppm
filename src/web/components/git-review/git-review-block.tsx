/**
 * One block of the Review changes tab: its bar (where it is, what is decided,
 * the answers on a desktop) over its lines, and the folded unchanged lines
 * between blocks.
 *
 * A block is open, staged (a dashed edge and Unstage) or discarded (only the
 * lines it put back, and Undo); an open one can be narrowed to some of its
 * lines first, which ticks each changed line and stages the ticked ones.
 */
import { memo, useMemo, type ReactNode } from "react";
import type { ThemedToken } from "shiki";
import { Check, CheckCircle2, Loader2, TextSelect, Trash2, Undo2 } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { changedSpans } from "@/lib/session-review-model";
import { numberedRows, pickableLines, rangeText, type BlockPart, type ReviewBlock, type ReviewRow } from "@/lib/git-review-model";
import { CheckBox, LineCounts } from "@/components/git/git-change-parts";
import { Kbd } from "@/components/session-review/review-code";
import { CodeLine, useTokenLines } from "@/components/session-review/review-tokens";
import type { ReviewRow as SpanRow } from "../../../shared/review-blocks";

export interface BlockActions {
  focus: (key: string) => void;
  stage: (key: string) => void;
  discard: (key: string) => void;
  unstage: (key: string) => void;
  undoDiscard: (recordId: string) => void;
  startPick: (key?: string) => void;
  togglePickLine: (line: number) => void;
  setPick: (lines: number[] | null) => void;
  stagePicked: () => void;
}

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;

/** Unchanged lines between two blocks: a count, folded. */
export function ReviewGap({ lines, compact }: { lines: number; compact: boolean }) {
  return (
    <div
      className={cn(
        "my-0.5 flex h-7 items-center gap-2 font-sans text-[11.5px] font-medium text-text-3",
        compact ? "pl-[38px]" : "pl-[54px]",
      )}
    >
      <span className="h-px w-3 bg-[repeating-linear-gradient(90deg,var(--border)_0_4px,transparent_4px_8px)]" />
      {plural(lines, "unchanged line")}
      <span className={cn("h-px flex-1 bg-[repeating-linear-gradient(90deg,var(--border)_0_4px,transparent_4px_8px)]", compact ? "mr-2.5" : "mr-3.5")} />
    </div>
  );
}

const linkButton =
  "inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-[5px] px-1.5 text-[11.5px] font-medium text-text-2 hover:bg-surface-hover hover:text-text disabled:pointer-events-none disabled:opacity-45";
const keyButton =
  "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[7px] border pl-2.5 text-[12.5px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-45";

export const ReviewBlockCard = memo(function ReviewBlockCard({ name, oldPath, block, index, total, focused, pick, compact, lang, busy, actions }: {
  /** The file's name, for what a whole-file block says. */
  name: string;
  oldPath?: string;
  block: ReviewBlock;
  index: number;
  total: number;
  focused: boolean;
  /** The ticked lines, while this block's lines are being picked. */
  pick: ReadonlySet<number> | null;
  /** The phone layout: narrower gutters, and the answers live in the bottom bar. */
  compact: boolean;
  lang: string | undefined;
  /** A write is in flight: the answers wait for it. */
  busy: boolean;
  actions: { current: BlockActions };
}) {
  const act = actions.current;
  const range = rangeText(block);
  const counts = <LineCounts added={block.added} removed={block.removed} />;
  const staged = block.state === "staged";
  const gone = block.state === "discarded";
  const picking = !!pick && focused && block.state === "open";
  const pickable = picking ? pickableLines(block) : [];

  let bar: ReactNode;
  if (gone) {
    bar = (
      <>
        <span className="inline-flex items-center gap-[5px] font-semibold text-error"><Trash2 className="size-3.5" />Discarded</span>
        <span>{range}</span>
        <span className="flex-1" />
        {!compact && block.recordId && (
          <button type="button" className={linkButton} disabled={busy} onClick={() => act.undoDiscard(block.recordId!)}>
            <Undo2 className="size-3.5" />Undo
          </button>
        )}
      </>
    );
  } else if (staged) {
    bar = (
      <>
        <span className="inline-flex items-center gap-[5px] font-semibold text-primary"><CheckCircle2 className="size-3.5" />Staged</span>
        <span>{range}</span>
        {counts}
        <span className="flex-1" />
        {!compact && (
          <button type="button" className={linkButton} onClick={() => act.unstage(block.key)}>
            <Undo2 className="size-3.5" />Unstage
          </button>
        )}
      </>
    );
  } else if (picking) {
    bar = (
      <>
        <b className="font-semibold text-text-2">Pick lines</b>
        <span>{pick!.size} of {pickable.length} selected</span>
        <span className="flex-1" />
        <button type="button" className={linkButton} onClick={() => act.setPick(pickable)}>All</button>
        <button type="button" className={linkButton} onClick={() => act.setPick([])}>None</button>
        <button type="button" className={cn(keyButton, "border-border bg-bg pr-1.5 text-text hover:border-text/30")} onClick={() => act.setPick(null)}>
          Cancel<Kbd>Esc</Kbd>
        </button>
        <button
          type="button"
          className={cn(keyButton, "border-transparent bg-primary pr-1.5 text-primary-foreground hover:bg-primary/90")}
          disabled={!pick!.size}
          onClick={act.stagePicked}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          Stage {plural(pick!.size, "line")}<Kbd className="border-white/30 bg-white/15 text-inherit">Y</Kbd>
        </button>
      </>
    );
  } else {
    bar = (
      <>
        <span><b className="font-semibold text-text-2">Block {index + 1}</b> of {total}</span>
        <span>{range}</span>
        {counts}
        <span className="flex-1" />
        {!compact && (
          <>
            {block.hunk && block.parts && (
              <button type="button" className={linkButton} title="Stage single lines (L)" onClick={() => act.startPick(block.key)}>
                <TextSelect className="size-3.5" />Lines…
              </button>
            )}
            <button
              type="button"
              title="Discard this block (N)"
              className={cn(keyButton, focused ? "pr-1.5" : "pr-2.5", "border-border bg-bg text-text hover:border-error/50 hover:text-error")}
              onClick={() => act.discard(block.key)}
            >
              <Trash2 className="size-3.5" />Discard{focused && <Kbd>N</Kbd>}
            </button>
            <button
              type="button"
              title="Stage this block (Y)"
              className={cn(keyButton, focused ? "pr-1.5" : "pr-2.5", "border-transparent bg-primary text-primary-foreground hover:bg-primary/90")}
              onClick={() => act.stage(block.key)}
            >
              <Check className="size-3.5" />Stage{focused && <Kbd className="border-white/30 bg-white/15 text-inherit">Y</Kbd>}
            </button>
          </>
        )}
      </>
    );
  }

  return (
    <div
      data-block-key={block.key}
      data-state={block.state}
      data-focused={focused || undefined}
      onClick={(e) => {
        if (!focused && !(e.target as HTMLElement).closest("button")) act.focus(block.key);
      }}
      className={cn(
        "relative rounded-lg border bg-bg",
        compact ? "mx-2 my-1.5" : "mr-3 ml-2 my-1.5",
        staged ? "border-dashed border-primary/45" : gone ? "border-dashed border-border-soft" : "border-border-soft",
        focused ? "border-primary/60 shadow-[0_0_0_3px_var(--accent-wash)]" : !compact && "cursor-pointer",
      )}
    >
      <div
        className={cn(
          "relative flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-t-[7px] py-1 pr-1.5 pl-3 font-sans text-xs leading-[1.3] text-text-3",
          staged || gone ? "min-h-8" : "min-h-[38px] border-b border-border-soft",
          !staged && !gone && (focused ? "bg-[color-mix(in_srgb,var(--accent)_7%,var(--panel))]" : "bg-panel"),
        )}
      >
        {bar}
      </div>
      <div
        className={cn(
          "overflow-hidden rounded-b-[7px] py-0.5",
          staged && "shadow-[inset_2px_0_0_var(--accent)]",
          gone && "shadow-[inset_2px_0_0_color-mix(in_srgb,var(--error)_60%,transparent)]",
        )}
      >
        <BlockBody name={name} oldPath={oldPath} block={block} compact={compact} lang={lang} pick={picking ? pick : null} onToggle={act.togglePickLine} />
      </div>
    </div>
  );
});

function BlockBody({ name, oldPath, block, compact, lang, pick, onToggle }: {
  name: string;
  oldPath?: string;
  block: ReviewBlock;
  compact: boolean;
  lang: string | undefined;
  pick: ReadonlySet<number> | null;
  onToggle: (line: number) => void;
}) {
  if (block.whole) {
    return (
      <>
        <WholeNote name={name} oldPath={oldPath} block={block} />
        {block.parts?.map((part, i) => (
          <div key={i} className={cn(i > 0 && "mt-1 border-t border-dashed border-border-soft pt-1")}>
            <DiffRows part={part} state={block.state} compact={compact} lang={lang} pick={null} onToggle={onToggle} />
          </div>
        ))}
      </>
    );
  }
  const part = block.parts?.[0];
  if (!part) {
    return (
      <div className="flex items-center gap-2 px-3 py-2.5 font-sans text-xs text-text-3">
        <Loader2 className="size-3.5 animate-spin" />Loading the lines…
      </div>
    );
  }
  return <DiffRows part={part} state={block.state} compact={compact} lang={lang} pick={pick} onToggle={onToggle} />;
}

/** What a block that stands for the whole file says instead of lines. */
function WholeNote({ name, oldPath, block }: { name: string; oldPath?: string; block: ReviewBlock }) {
  const file = <b className="font-semibold text-text">{name}</b>;
  const lines = block.removed ? `all ${plural(block.removed, "line")}` : "an empty file";
  let text: ReactNode;
  if (block.state === "discarded") {
    text = block.whole === "deleted" ? <>{file} is back. Undo deletes it again.</> : <>The changes to {file} are discarded. Undo puts them back.</>;
  } else {
    switch (block.whole) {
      case "deleted":
        text = block.state === "staged"
          ? <>{file} is deleted — {lines}. The next commit deletes it.</>
          : <>{file} is deleted — {lines}. Stage it to delete the file in the next commit, or discard to bring it back.</>;
        break;
      case "binary":
        text = <>{file} is a binary file: git cannot show it as lines, so it is staged or discarded whole.</>;
        break;
      case "large":
        text = <>{file} is too big to split into blocks, so it is staged or discarded whole.</>;
        break;
      case "rename":
        text = <>Renamed from <b className="font-semibold text-text">{oldPath ?? "another path"}</b>. git takes a rename as one change{block.parts?.length ? ", edits included" : ""}.</>;
        break;
      case "submodule":
        text = <>{file} is a submodule: what changed is the commit it points to.</>;
        break;
      case "mode":
        text = <>Only the file mode of {file} changed.</>;
        break;
      case "type":
        text = <>{file} changed kind — a file became a link, or the other way round.</>;
        break;
      case "unread":
        text = <>{file} was not read: a new folder, or past the number of new files PPM lists.</>;
        break;
      default:
        text = <>{file} is an empty file.</>;
    }
  }
  const Icon = block.whole === "deleted" || block.state === "discarded" ? Trash2 : null;
  return (
    <div className="flex items-center gap-3 px-3.5 py-3 font-sans text-[13px] leading-normal text-text-2">
      {Icon && <Icon className={cn("size-5 shrink-0", block.state === "discarded" ? "text-text-3" : "text-error")} />}
      <span>{text}</span>
    </div>
  );
}

/**
 * A block's lines with their numbers and syntax colours. A discarded block
 * shows only the lines it left behind; a pick puts a tick in each changed
 * line's sign column, and an unticked line loses its tint.
 */
function DiffRows({ part, state, compact, lang, pick, onToggle }: {
  part: BlockPart;
  state: ReviewBlock["state"];
  compact: boolean;
  lang: string | undefined;
  pick: ReadonlySet<number> | null;
  onToggle: (line: number) => void;
}) {
  const rows = useMemo(() => numberedRows(part), [part]);
  const oldText = useMemo(() => rows.filter((r) => r.kind !== "+").map((r) => r.text).join("\n"), [rows]);
  const newText = useMemo(() => rows.filter((r) => r.kind !== "-").map((r) => r.text).join("\n"), [rows]);
  const [oldTokens, newTokens] = useTokenLines([oldText, newText], lang);
  const spans = useMemo(() => changedSpans(rows.map((r): SpanRow => ({ k: r.kind, text: r.text, o: r.old, n: r.new }))), [rows]);

  const drawn = useMemo(() => {
    let o = 0;
    let n = 0;
    const out: { row: ReviewRow; tokens: ThemedToken[] | undefined; i: number }[] = [];
    rows.forEach((row, i) => {
      const oldTok = row.kind !== "+" ? oldTokens?.[o] : undefined;
      const newTok = row.kind !== "-" ? newTokens?.[n] : undefined;
      if (row.kind !== "+") o++;
      if (row.kind !== "-") n++;
      out.push({ row, tokens: row.kind === "-" ? oldTok : newTok, i });
    });
    return out;
  }, [rows, oldTokens, newTokens]);

  const grid = compact ? "grid-cols-[30px_30px_16px_minmax(0,1fr)]" : "grid-cols-[44px_44px_22px_minmax(0,1fr)]";
  // A discarded block still shows what was thrown away, dimmed, so Undo has something to answer for.
  const gone = state === "discarded";
  const tint = state === "staged" ? { add: "bg-diff-added/60", del: "bg-diff-removed/60" } : { add: "bg-diff-added", del: "bg-diff-removed" };
  return (
    <>
      {drawn.map(({ row, tokens, i }) => {
        const changed = row.kind !== " ";
        const ticked = !!pick && changed && pick.has(row.at);
        const off = !!pick && changed && !ticked;
        const add = row.kind === "+" && !off;
        const del = row.kind === "-" && !off;
        const number = cn("select-none text-right text-[0.92em] text-text-3", compact ? "pr-[5px]" : "pr-2");
        return (
          <div
            key={i}
            className={cn("grid", grid, add && tint.add, del && tint.del, pick && changed && "cursor-pointer")}
            onClick={pick && changed ? () => onToggle(row.at) : undefined}
            role={pick && changed ? "checkbox" : undefined}
            aria-checked={pick && changed ? ticked : undefined}
          >
            <span className={number}>{row.old ?? ""}</span>
            <span className={number}>{row.new ?? ""}</span>
            <span className={cn("grid h-[1lh] select-none place-items-center self-start", row.kind === "+" ? "text-success" : row.kind === "-" ? "text-error" : "text-text-3")}>
              {pick && changed ? <CheckBox state={ticked ? "all" : "none"} className="size-3.5 md:size-3.5 rounded-[3.5px] md:rounded-[3.5px]" /> : row.kind === "+" ? "+" : row.kind === "-" ? "−" : ""}
            </span>
            <span className={cn("min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]", compact ? "pr-2.5" : "pr-3.5", off && "opacity-55", gone && "opacity-70")}>
              <CodeLine
                text={row.text}
                tokens={tokens}
                span={spans?.[i] ?? null}
                spanClass={cn("rounded-[2px]", row.kind === "+" ? "bg-diff-added-word" : "bg-diff-removed-word")}
              />
            </span>
          </div>
        );
      })}
    </>
  );
}
