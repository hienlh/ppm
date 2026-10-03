/**
 * The file in focus, drawn the way an editor's review draws it: each change block where it sits
 * in the file, with the unchanged lines between blocks folded away. An open block shows its diff
 * and, on a desktop, its Keep and Revert; a decided one shows only the lines that stay. Each
 * block names the turns that wrote it, and a turn opens to the prompt that asked for it.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ThemedToken } from "shiki";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { ArrowUp, Check, ChevronsUpDown, Copy, GitBranch, History, MessageCircle, RotateCcw, Undo2 } from "@/lib/icons";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { changedSpans, shownRows, type BlockState, type PaneItem, type PaneModel } from "@/lib/session-review-model";
import { turnLabel, turnTime, type SessionTurn } from "@/lib/session-turns";
import type { ReviewRow } from "../../../shared/review-blocks";
import type { SessionFileChange } from "../../../shared/session-file-changes";
import { CodeLine, useTokenLines } from "./review-tokens";

type BlockItem = Extract<PaneItem, { kind: "block" }>;

export interface ReviewCodeActions {
  focus: (key: string) => void;
  keep: (key: string) => void;
  revert: (key: string) => void;
  reopen: (key: string) => void;
  undo: (undoId: string, key: string) => void;
  /** Show the chat at the call that wrote a block, or at the turn's prompt. */
  showInChat: (turn: SessionTurn, call: string) => void;
}

/** A turn that wrote a block, and the first of the block's calls it made. */
interface TurnChip {
  turn: SessionTurn;
  call: string;
}

/** The turns that wrote a block, oldest first. */
function blockTurns(calls: readonly string[] | undefined, turns: ReadonlyMap<string, SessionTurn>): TurnChip[] {
  const out: TurnChip[] = [];
  for (const call of calls ?? []) {
    const turn = turns.get(call);
    if (turn && !out.some((c) => c.turn === turn)) out.push({ turn, call });
  }
  return out.sort((a, b) => Date.parse(a.turn.at) - Date.parse(b.turn.at));
}

const sameChips = (a: readonly TurnChip[], b: readonly TurnChip[]) =>
  a.length === b.length && a.every((c, i) => c.turn === b[i]!.turn && c.call === b[i]!.call);

/** Unchanged lines a fold opens at a time; a fold not much longer opens whole. */
const GAP_STEP = 200;

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-grid h-4 min-w-4 place-items-center rounded border border-b-2 border-border bg-panel px-1 font-mono text-[10px] font-medium leading-none text-text-2",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function ReviewCode({ file, model, focusKey, compact, lang, turns, actions }: {
  file: SessionFileChange;
  model: PaneModel;
  focusKey: string | null;
  /** The phone layout: narrower gutters, and the answers live in the bottom bar. */
  compact: boolean;
  lang: string | undefined;
  /** Each call's turn, for the turns a block names. */
  turns: ReadonlyMap<string, SessionTurn>;
  actions: ReviewCodeActions;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const act = useRef(actions);
  act.current = actions;
  const [opened, setOpened] = useState<ReadonlyMap<number, number>>(new Map());
  const name = file.path.slice(Math.max(file.path.lastIndexOf("/"), file.path.lastIndexOf("\\")) + 1);

  // One turn open at a time: under its chip on a desktop, in a sheet on a phone.
  const [pop, setPop] = useState<{ key: string; chip: TurnChip } | null>(null);
  const chips = useMemo(() => {
    const out = new Map<string, TurnChip[]>();
    for (const item of model.items) if (item.kind === "block") out.set(item.key, blockTurns(item.calls, turns));
    return out;
  }, [model.items, turns]);
  const toggleTurn = useCallback((key: string, chip: TurnChip) => {
    setPop((cur) => (cur?.key === key && cur.chip.turn.messageId === chip.turn.messageId ? null : { key, chip }));
  }, []);
  const closeTurn = useCallback(() => setPop(null), []);
  useEffect(() => {
    if (!pop || compact) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-turn-pop], [data-turn-chip]")) setPop(null);
    };
    // Before the tab's own keys, which leave alone a key something already answered.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setPop(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [pop, compact]);

  // Bring the block in focus into view, unless it already is.
  useLayoutEffect(() => {
    const box = scroller.current;
    const el = focusKey ? box?.querySelector<HTMLElement>(`[data-block-key="${CSS.escape(focusKey)}"]`) : null;
    if (!box || !el) return;
    const top = el.offsetTop - 12;
    const bottom = el.offsetTop + Math.min(el.offsetHeight, box.clientHeight - 40);
    if (top < box.scrollTop || bottom > box.scrollTop + box.clientHeight) box.scrollTop = top;
  }, [focusKey, model.total]);

  return (
    <div
      ref={scroller}
      data-testid="review-code"
      className={cn(
        "relative min-h-0 flex-1 overflow-auto bg-bg font-mono [tab-size:4]",
        compact ? "pt-2 pb-3 text-[11px] leading-[1.65]" : "pt-2.5 pb-6 text-[12px] leading-[1.7]",
      )}
    >
      {file.sinceReview ? (
        <Note icon={<History className="size-3.5 text-accent-2" />} tint="var(--accent-2)" compact={compact}>
          You reviewed this file before; only what changed after that is open again.
        </Note>
      ) : file.baseline === "head" && (
        <Note icon={<GitBranch className="size-3.5 text-warning" />} tint="var(--warning)" compact={compact}>
          This chat kept no copy of <b className="font-semibold text-text">{name}</b> from before it changed it, so these
          blocks compare with the last commit.
        </Note>
      )}
      {model.items.map((item) => item.kind === "gap" ? (
        <Gap
          key={`gap:${item.from}`}
          from={item.from}
          to={item.to}
          model={model}
          shown={opened.get(item.from) ?? 0}
          compact={compact}
          lang={lang}
          onOpen={(n) => setOpened((cur) => new Map(cur).set(item.from, n))}
        />
      ) : (
        <Block
          key={`block:${item.key}`}
          item={item}
          total={model.total}
          focused={item.key === focusKey}
          compact={compact}
          lang={lang}
          chips={chips.get(item.key) ?? NO_CHIPS}
          openTurn={!compact && pop?.key === item.key ? pop.chip : null}
          onTurn={toggleTurn}
          onCloseTurn={closeTurn}
          act={act}
        />
      ))}
      {compact && (
        <BottomSheet open={!!pop} onClose={closeTurn}>
          {pop && <TurnCard chip={pop.chip} compact onClose={closeTurn} act={act} />}
        </BottomSheet>
      )}
    </div>
  );
}

const NO_CHIPS: TurnChip[] = [];

/** The prompt behind a turn, with a way to copy it and to see the turn in the chat. */
function TurnCard({ chip, compact, onClose, act }: {
  chip: TurnChip;
  compact: boolean;
  onClose: () => void;
  act: { current: ReviewCodeActions };
}) {
  const { turn, call } = chip;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const time = turnTime(turn.at);
  return (
    <div
      data-turn-pop
      onClick={(e) => e.stopPropagation()}
      className={cn("font-sans text-text-2", compact ? "px-4 pb-1 text-sm" : "text-[12.5px] leading-normal")}
    >
      <h5 className={cn("m-0 mb-1.5 flex items-center gap-2 font-semibold text-text", compact ? "text-[15px]" : "text-[13px]")}>
        <MessageCircle className={compact ? "size-5" : "size-4"} />
        {turnLabel(turn)}{time && ` · ${time}`}
      </h5>
      <blockquote
        className={cn(
          "m-0 mb-2.5 overflow-y-auto whitespace-pre-wrap rounded-r-md border-l-2 border-primary bg-[color-mix(in_srgb,var(--text)_5%,transparent)] px-2.5 py-2 leading-[1.45] text-text [overflow-wrap:anywhere]",
          compact ? "max-h-[40vh] text-sm" : "max-h-48 text-[13px]",
        )}
      >
        {turn.prompt || <span className="text-text-subtle">No text — the prompt was only attachments.</span>}
      </blockquote>
      <div className={cn("flex justify-end gap-1.5", compact && "gap-2")}>
        <Button
          variant={compact ? "outline" : "ghost"}
          size={compact ? "lg" : "sm"}
          className={cn(compact && "h-11 flex-1")}
          onClick={() => void copyToClipboard(turn.prompt).then((ok) => ok && setCopied(true))}
        >
          {copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy prompt"}
        </Button>
        <Button
          size={compact ? "lg" : "sm"}
          className={cn(compact && "h-11 flex-1")}
          onClick={() => {
            onClose();
            act.current.showInChat(turn, call);
          }}
        >
          Show in chat<ArrowUp />
        </Button>
      </div>
    </div>
  );
}

function Note({ icon, tint, compact, children }: { icon: ReactNode; tint: string; compact: boolean; children: ReactNode }) {
  return (
    <div
      className={cn("mb-1.5 flex items-center gap-2 rounded-lg px-3 py-2 font-sans text-xs leading-[1.45] text-text-2", compact ? "mx-2 ml-1.5" : "mx-3 ml-2")}
      style={{ background: `color-mix(in srgb, ${tint} 9%, transparent)` }}
    >
      <span className="shrink-0">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Folded unchanged lines, opened `GAP_STEP` at a time from the top. */
function Gap({ from, to, model, shown, compact, lang, onOpen }: {
  from: number;
  to: number;
  model: PaneModel;
  shown: number;
  compact: boolean;
  lang: string | undefined;
  onOpen: (shown: number) => void;
}) {
  const rows = useMemo((): ReviewRow[] => {
    const out: ReviewRow[] = [];
    for (let i = from; i < from + shown && i < to; i++) out.push({ k: " ", text: model.lines[i] ?? "", o: model.baseLine[i] || null, n: i + 1 });
    return out;
  }, [from, to, shown, model]);
  const left = to - from - shown;
  const next = left <= GAP_STEP * 1.5 ? left : GAP_STEP;
  return (
    <>
      {rows.length > 0 && (
        // Inset by a block's margins plus its 1px border, so a line number keeps its column
        // across the card's edge.
        <div className={compact ? "pr-[9px] pl-[7px]" : "pr-[13px] pl-[9px]"}>
          <Rows rows={rows} state="kept" compact={compact} lang={lang} plain />
        </div>
      )}
      {left > 0 && (
        <div className={cn("my-0.5 flex items-center gap-2 font-sans text-[11.5px] font-medium text-text-subtle", compact ? "min-h-11 pl-[34px]" : "h-[26px] pl-[50px]")}>
          <span className="h-px w-3 bg-[repeating-linear-gradient(90deg,var(--border)_0_4px,transparent_4px_8px)]" />
          <button
            type="button"
            title={next < left ? `Show the next ${next}` : undefined}
            onClick={() => onOpen(shown + next)}
            className={cn(
              "inline-flex items-center gap-1.5 whitespace-nowrap rounded-[5px] px-1.5 text-text-subtle hover:bg-surface-hover hover:text-text",
              compact ? "h-11" : "h-[22px]",
            )}
          >
            <ChevronsUpDown className="size-3.5" />
            {plural(left, shown ? "more unchanged line" : "unchanged line")}
          </button>
          <span className={cn("h-px flex-1 bg-[repeating-linear-gradient(90deg,var(--border)_0_4px,transparent_4px_8px)]", compact ? "mr-2.5" : "mr-3.5")} />
        </div>
      )}
    </>
  );
}

const answerButton = "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[7px] border pl-2.5 text-[12.5px] font-medium transition-colors";

const Block = memo(function Block({ item, total, focused, compact, lang, chips, openTurn, onTurn, onCloseTurn, act }: {
  item: BlockItem;
  total: number;
  focused: boolean;
  compact: boolean;
  lang: string | undefined;
  chips: readonly TurnChip[];
  /** The turn whose card is open under this block's bar. */
  openTurn: TurnChip | null;
  onTurn: (key: string, chip: TurnChip) => void;
  onCloseTurn: () => void;
  act: { current: ReviewCodeActions };
}) {
  const open = item.state === "open";
  const kept = item.state === "kept";
  const place = `${item.index + 1} of ${total}`;
  const turnChips = chips.map((chip) => {
    const expanded = openTurn?.turn === chip.turn;
    const time = turnTime(chip.turn.at);
    return (
      <button
        key={chip.turn.messageId}
        type="button"
        data-turn-chip
        aria-expanded={expanded}
        title={chip.turn.prompt}
        onClick={() => onTurn(item.key, chip)}
        className={cn(
          "relative inline-flex h-6 items-center gap-[5px] whitespace-nowrap rounded-md border px-[7px] text-[11.5px] text-text-2",
          // A 44px touch target: the pseudo-element is placed against the padding box, 1px inside the border.
          "pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-[11px] pointer-coarse:before:content-['']",
          expanded ? "border-border bg-panel-2 text-text" : "border-border-soft bg-bg hover:border-border hover:bg-panel-2 hover:text-text",
        )}
      >
        <MessageCircle className="size-3" />
        <b className="font-semibold text-text">{turnLabel(chip.turn)}</b>
        {time && <span>· {time}</span>}
      </button>
    );
  });
  return (
    <div
      data-block-key={item.key}
      data-state={item.state}
      data-focused={focused || undefined}
      onClick={(e) => { if (!focused && !(e.target as HTMLElement).closest("button")) act.current.focus(item.key); }}
      className={cn(
        "relative my-1.5 rounded-[10px] border border-border-soft bg-bg",
        // Gap's opened lines repeat these margins, plus the border, as their inset.
        compact ? "mr-2 ml-1.5" : "mr-3 ml-2",
        !open && "border-dashed",
        focused ? "border-primary/60 shadow-[0_0_0_3px_var(--accent-wash)]" : "cursor-pointer",
      )}
    >
      <div
        className={cn(
          "relative flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-t-[9px] py-1 pr-1.5 pl-2.5 font-sans text-xs leading-[1.3] text-text-subtle",
          open ? "min-h-9 border-b border-border-soft" : "min-h-[30px]",
          open && (focused ? "bg-[color-mix(in_srgb,var(--accent)_7%,var(--panel))]" : "bg-panel"),
        )}
      >
        {open ? (
          <span><b className="font-semibold text-text-2">Block {item.index + 1}</b> of {total}</span>
        ) : (
          <>
            <span className={cn("inline-flex items-center gap-1 font-semibold", kept ? "text-primary" : "text-error")}>
              {kept ? <Check className="size-3.5" /> : <RotateCcw className="size-3.5" />}
              {kept ? "Kept" : "Reverted"}
            </span>
            <span>· block {place}</span>
          </>
        )}
        {turnChips}
        <span className="flex-1" />
        {!compact && (open ? (
          <>
            <button
              type="button"
              title="Put these lines back (N)"
              onClick={() => act.current.revert(item.key)}
              className={cn(answerButton, focused ? "pr-1.5" : "pr-2.5", "border-border bg-bg text-text hover:border-error/50 hover:text-error")}
            >
              <RotateCcw className="size-3.5" />Revert{focused && <Kbd>N</Kbd>}
            </button>
            <button
              type="button"
              title="Keep this change (Y)"
              onClick={() => act.current.keep(item.key)}
              className={cn(answerButton, focused ? "pr-1.5" : "pr-2.5", "border-transparent bg-primary text-primary-foreground hover:bg-primary/90")}
            >
              <Check className="size-3.5" />Keep{focused && <Kbd className="border-white/30 bg-white/15 text-inherit">Y</Kbd>}
            </button>
          </>
        ) : (
          <ChangeButton item={item} act={act} />
        ))}
        {openTurn && (
          <div className="absolute top-full left-2 z-40 mt-1 w-[330px] max-w-[calc(100%-24px)] rounded-xl border border-border bg-panel-2 p-3.5 shadow-[0_18px_40px_-16px_rgba(0,0,0,.6)]">
            <TurnCard chip={openTurn} compact={false} onClose={onCloseTurn} act={act} />
          </div>
        )}
      </div>
      <div
        className={cn(
          "overflow-hidden rounded-b-[9px]",
          kept && "shadow-[inset_2px_0_0_color-mix(in_srgb,var(--accent)_75%,transparent)]",
          item.state === "reverted" && "shadow-[inset_2px_0_0_color-mix(in_srgb,var(--error)_60%,transparent)]",
        )}
      >
        <Rows rows={item.rows} state={item.state} compact={compact} lang={lang} />
      </div>
    </div>
  );
}, (a, b) =>
  a.item.key === b.item.key && a.item.state === b.item.state && a.item.rows === b.item.rows && a.item.index === b.item.index
  && a.item.undoId === b.item.undoId && a.total === b.total && a.focused === b.focused && a.compact === b.compact && a.lang === b.lang
  && sameChips(a.chips, b.chips) && a.openTurn === b.openTurn && a.onTurn === b.onTurn);

/** Open a decided block again: a kept one is reopened, a reverted one's revert is undone. */
function ChangeButton({ item, act }: { item: BlockItem; act: { current: ReviewCodeActions } }) {
  const reverted = item.state === "reverted";
  return (
    <button
      type="button"
      disabled={reverted && !item.undoId}
      title={reverted ? "Put back what the agent wrote here" : "Open this block again"}
      onClick={() => (reverted ? item.undoId && act.current.undo(item.undoId, item.key) : act.current.reopen(item.key))}
      className="inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-[5px] px-1.5 text-[11.5px] font-medium text-text-2 hover:bg-surface-hover hover:text-text disabled:opacity-50"
    >
      <Undo2 className="size-3.5" />Change
    </button>
  );
}

/**
 * A block's rows: the diff while it is open, the lines that stay once it is answered. `plain`
 * draws unchanged lines with both numbers, for an opened fold.
 */
function Rows({ rows, state, compact, lang, plain }: {
  rows: ReviewRow[];
  state: BlockState;
  compact: boolean;
  lang: string | undefined;
  plain?: boolean;
}) {
  const oldText = useMemo(() => rows.filter((r) => r.k !== "+").map((r) => r.text).join("\n"), [rows]);
  const newText = useMemo(() => rows.filter((r) => r.k !== "-").map((r) => r.text).join("\n"), [rows]);
  const [oldTokens, newTokens] = useTokenLines([oldText, newText], lang);
  const spans = useMemo(() => (state === "open" ? changedSpans(rows) : null), [rows, state]);

  const drawn = useMemo(() => {
    let o = 0;
    let n = 0;
    const out: { row: ReviewRow; at: number; tokens: ThemedToken[] | undefined }[] = [];
    rows.forEach((row, at) => {
      const tokens = row.k === "-" ? oldTokens?.[o] : newTokens?.[n];
      if (row.k !== "+") o++;
      if (row.k !== "-") n++;
      out.push({ row, at, tokens });
    });
    const keep = new Set(shownRows(rows, state));
    return out.filter((d) => keep.has(d.row));
  }, [rows, state, oldTokens, newTokens]);

  const grid = compact ? "grid-cols-[28px_28px_14px_minmax(0,1fr)]" : "grid-cols-[40px_40px_18px_minmax(0,1fr)]";
  if (drawn.length === 0) {
    return (
      <div className={cn("grid", grid)}>
        <span /><span /><span />
        <span className="py-0.5 font-sans text-text-subtle">
          {state === "kept" ? "The file is deleted — nothing of it stays." : "The file is gone again — it did not exist before this chat."}
        </span>
      </div>
    );
  }
  const decided = state !== "open" && !plain;
  return (
    <>
      {drawn.map(({ row, at, tokens }) => {
        const add = state === "open" && row.k === "+";
        const del = state === "open" && row.k === "-";
        return (
          <div key={at} className={cn("grid", grid, add && "bg-diff-added", del && "bg-diff-removed")}>
            <span className={cn("select-none text-right text-[0.92em] text-text-subtle", compact ? "pr-[5px]" : "pr-2")}>
              {state === "kept" && !plain ? "" : row.o ?? ""}
            </span>
            <span className={cn("select-none text-right text-[0.92em] text-text-subtle", compact ? "pr-[5px]" : "pr-2")}>
              {state === "reverted" ? "" : row.n ?? ""}
            </span>
            <span className={cn("select-none text-center", add ? "text-success" : del ? "text-error" : "text-text-subtle")}>
              {add ? "+" : del ? "−" : ""}
            </span>
            <span className={cn("min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]", compact ? "pr-2.5" : "pr-3.5", decided && "opacity-[.78]")}>
              <CodeLine
                text={row.text}
                tokens={tokens}
                span={spans?.[at] ?? null}
                spanClass={cn("rounded-[2px]", row.k === "+" ? "bg-diff-added-word" : "bg-diff-removed-word")}
              />
            </span>
          </div>
        );
      })}
    </>
  );
}
