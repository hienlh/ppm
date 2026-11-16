/**
 * The look of a question form, shared by the chat's AskUserQuestion card (`question-card.tsx`) and
 * the PPM Assistant's set of decisions (`assistant/cards/decision-set/`): the frame, the tab strip,
 * a numbered option tile and the dashed "Other" row. Both read as the same kind of thing because
 * they are drawn by the same parts; only the tone differs — the chat's question is blue, a
 * manager's decision amber, an urgent one red.
 *
 * Tailwind only builds classes it can read in the source, so every tone spells its classes out.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type QuestionTone = "question" | "decision" | "urgent";

interface ToneClasses {
  frame: string;
  tabOn: string;
  tabMarkOn: string;
  tabAnswered: string;
  tabMarkAnswered: string;
  tileOn: string;
  tileHover: string;
  badgeOn: string;
  ring: string;
  inputFocus: string;
}

const TONES: Record<QuestionTone, ToneClasses> = {
  question: {
    frame: "border-primary/30 bg-primary/5",
    tabOn: "bg-primary text-primary-foreground",
    tabMarkOn: "bg-white/20",
    tabAnswered: "text-primary bg-transparent",
    tabMarkAnswered: "bg-primary/20 text-primary",
    tileOn: "border-primary bg-primary/10 text-text-primary",
    tileHover: "hover:border-primary/40 hover:bg-primary/5",
    badgeOn: "bg-primary/20 text-primary",
    ring: "ring-primary/40",
    inputFocus: "focus:border-primary",
  },
  decision: {
    frame: "border-warning/40 bg-warning/5",
    tabOn: "bg-warning text-neutral-950",
    tabMarkOn: "bg-black/15",
    tabAnswered: "text-warning bg-transparent",
    tabMarkAnswered: "bg-warning/20 text-warning",
    tileOn: "border-warning bg-warning/10 text-text-primary",
    tileHover: "hover:border-warning/40 hover:bg-warning/5",
    badgeOn: "bg-warning text-neutral-950",
    ring: "ring-warning/40",
    inputFocus: "focus:border-warning",
  },
  urgent: {
    frame: "border-error/40 bg-error/5",
    tabOn: "bg-error text-neutral-950",
    tabMarkOn: "bg-black/15",
    tabAnswered: "text-error bg-transparent",
    tabMarkAnswered: "bg-error/20 text-error",
    tileOn: "border-error bg-error/10 text-text-primary",
    tileHover: "hover:border-error/40 hover:bg-error/5",
    badgeOn: "bg-error text-neutral-950",
    ring: "ring-error/40",
    inputFocus: "focus:border-error",
  },
};

export const questionTone = (tone: QuestionTone): ToneClasses => TONES[tone];

/** The frame around the whole form. */
export function questionFrameClass(tone: QuestionTone): string {
  return cn("rounded-lg border-2 p-3 space-y-3 outline-none", TONES[tone].frame);
}

/** A focus ring drawn around the option the arrow keys are on. */
const focusRing = (tone: QuestionTone) => cn("ring-2 ring-offset-1 ring-offset-background", TONES[tone].ring);

export interface QuestionTab {
  key: string;
  label: ReactNode;
  /** What the tab's dot shows: its number, ✓, ! … */
  mark: ReactNode;
  /** An answer is picked (question) or sent (decision): the tab shows it in the tone. */
  answered: boolean;
  /** Overrides the strip's tone for this tab (an urgent decision among ordinary ones). */
  tone?: QuestionTone;
  /** Extra classes (a tab that no longer waits is struck through). */
  className?: string;
  title?: string;
}

export function QuestionTabStrip({ tabs, active, tone, onSelect, className }: {
  tabs: readonly QuestionTab[];
  active: number;
  tone: QuestionTone;
  onSelect: (index: number) => void;
  className?: string;
}) {
  return (
    <div role="tablist" className={cn("flex gap-1 p-1 bg-background rounded-md overflow-x-auto border border-border", className)}>
      {tabs.map((tab, i) => {
        const t = TONES[tab.tone ?? tone];
        const on = active === i;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={on}
            title={tab.title}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded text-xs whitespace-nowrap transition-all",
              on ? t.tabOn : tab.answered ? t.tabAnswered : "text-text-secondary hover:bg-surface-elevated",
              tab.className,
            )}
            onClick={() => onSelect(i)}
            tabIndex={-1}
            data-question-tab={tab.key}
          >
            <span
              className={cn(
                "flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-semibold shrink-0",
                on ? t.tabMarkOn : tab.answered ? t.tabMarkAnswered : "bg-surface-elevated text-text-secondary",
              )}
            >
              {tab.mark}
            </span>
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** One option: its number, its label and what choosing it does. */
export function QuestionOptionTile({ index, label, description, selected, focused, tone, onSelect, children, disabled }: {
  index: number;
  label: ReactNode;
  description?: ReactNode;
  selected: boolean;
  focused: boolean;
  tone: QuestionTone;
  onSelect: () => void;
  /** More under the description (the draft hash an OK is bound to). */
  children?: ReactNode;
  disabled?: boolean;
}) {
  const t = TONES[tone];
  return (
    <div
      role="button"
      aria-pressed={selected}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onSelect}
      className={cn(
        "text-left flex items-start gap-2.5 rounded px-2.5 py-2 text-xs border transition-all cursor-pointer select-text",
        selected ? t.tileOn : cn("border-border bg-background text-text-secondary", t.tileHover),
        focused && focusRing(tone),
        disabled && "cursor-default opacity-60",
      )}
      data-question-option={index}
    >
      <span className={cn(
        "flex items-center justify-center w-4.5 h-4.5 rounded text-[10px] font-semibold shrink-0 mt-px",
        selected ? t.badgeOn : "bg-surface-elevated text-text-secondary",
      )}>
        {index + 1}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5 flex-1">
        <span className="font-medium text-text-primary break-words">{label}</span>
        {description && <span className="text-[11px] text-text-secondary break-words">{description}</span>}
        {children}
      </div>
    </div>
  );
}

/** The dashed "Other" row: an answer in the user's own words. */
export function QuestionOtherRow({ focused, filled, tone, children }: {
  focused: boolean;
  /** Something is typed (or attached): the row reads as the chosen answer. */
  filled?: boolean;
  tone: QuestionTone;
  children: ReactNode;
}) {
  const t = TONES[tone];
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded px-2.5 py-2 text-xs border transition-all",
        filled ? cn(t.tileOn, "border-solid") : "border-dashed border-border bg-transparent",
        focused && focusRing(tone),
      )}
      data-question-other=""
    >
      <span className={cn(
        "flex items-center justify-center w-4.5 h-4.5 rounded text-[10px] font-semibold shrink-0 mt-px",
        filled ? t.badgeOn : "bg-surface-elevated text-text-secondary",
      )}>
        O
      </span>
      {children}
    </div>
  );
}

/** The text field inside the "Other" row. */
export const questionInputClass = (tone: QuestionTone): string =>
  cn("flex-1 min-w-0 px-2 py-1 text-xs bg-surface border border-border rounded text-text-primary outline-none placeholder:text-text-subtle", TONES[tone].inputFocus);
