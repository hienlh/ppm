/**
 * A question's options as tiles: a letter (A, B, C…), the label, a "Recommended" tag where the
 * label carried "(Recommended)", and the whole description under it — descriptions are where a
 * manager explains the trade-off, so they are never cut. One choice per question unless the
 * question allows several (round marks vs square). Every tile is at least 44 px tall.
 *
 * A question that takes typed text gets one more row under its tiles, "Other": the user's own
 * words, as the chat's question form offers. Typing makes it the answer in place of any tile, and
 * picking a tile clears it, so the card sends exactly one of the two, as the chat does.
 */
import { Check, Pencil } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { escapeHiddenCharacters } from "../../../../shared/reveal-hidden-characters";

const RECOMMENDED = /\s*\(recommended\)\s*$/i;

/** An option's label without a trailing "(Recommended)", and whether it had one. */
export function splitRecommended(label: string): { text: string; recommended: boolean } {
  return RECOMMENDED.test(label) ? { text: label.replace(RECOMMENDED, ""), recommended: true } : { text: label, recommended: false };
}

/** "A", "B", … "Z", then "AA". */
export const optionLetter = (i: number): string =>
  i < 26 ? String.fromCharCode(65 + i) : `${optionLetter(Math.floor(i / 26) - 1)}${String.fromCharCode(65 + (i % 26))}`;

export function QuestionOptions({ label, options, multi, chosen, disabled, onPick, other }: {
  /** The question, for screen readers. */
  label: string;
  options: ReadonlyArray<{ label: string; description?: string }>;
  multi: boolean;
  chosen: readonly string[];
  disabled: boolean;
  onPick: (label: string) => void;
  /** The typed answer, for a question that takes one; left out, there is no "Other" row. */
  other?: { value: string; onChange: (value: string) => void };
}) {
  return (
    <div role={multi ? "group" : "radiogroup"} aria-label={label} className="mt-2 space-y-1.5" data-card-options="">
      {options.map((o, i) => {
        const on = chosen.includes(o.label);
        const { text, recommended } = splitRecommended(o.label);
        return (
          <button
            // By place: two options may carry the same label.
            key={i}
            type="button"
            role={multi ? "checkbox" : "radio"}
            aria-checked={on}
            disabled={disabled}
            onClick={() => onPick(o.label)}
            className={cn(
              "flex min-h-11 w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-default",
              on ? "border-primary bg-accent-wash" : "border-border bg-surface can-hover:enabled:hover:border-accent-wash-border can-hover:enabled:hover:bg-panel-2",
            )}
            data-card-option={optionLetter(i)}
          >
            <span
              aria-hidden
              className={cn(
                "mt-px grid size-6 shrink-0 place-items-center text-[11px] font-semibold",
                multi ? "rounded-md" : "rounded-full",
                on ? "bg-primary text-primary-foreground" : "border border-border bg-panel-2 text-text-secondary",
              )}
            >
              {on ? <Check className="size-3.5" /> : optionLetter(i)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-sm font-medium leading-snug text-text-primary">{escapeHiddenCharacters(text)}</span>
                {recommended && (
                  <span className="rounded-full bg-success/10 px-1.5 py-px text-[10.5px] font-semibold text-success">Recommended</span>
                )}
              </span>
              {o.description && (
                <span className="mt-0.5 block text-[13px] leading-relaxed text-text-secondary">{escapeHiddenCharacters(o.description)}</span>
              )}
            </span>
          </button>
        );
      })}
      {other && <OtherAnswer value={other.value} onChange={other.onChange} disabled={disabled} alone={options.length === 0} />}
    </div>
  );
}

/**
 * The "Other" row: a text field drawn like a tile, dashed until something is typed. It grows with
 * the words up to about six lines. 16 px text below `md`, so a phone does not zoom in on focus.
 */
function OtherAnswer({ value, onChange, disabled, alone }: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  /** The question has no tiles: the field is the whole answer. */
  alone: boolean;
}) {
  const filled = value.trim().length > 0;
  return (
    <label
      className={cn(
        "flex min-h-11 w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors",
        filled ? "border-primary bg-accent-wash" : "border-dashed border-border bg-surface focus-within:border-primary",
        disabled && "opacity-60",
      )}
      data-card-other=""
    >
      <span
        aria-hidden
        className={cn(
          "mt-px grid size-6 shrink-0 place-items-center rounded-full [&_svg]:size-3.5",
          filled ? "bg-primary text-primary-foreground" : "border border-border bg-panel-2 text-text-secondary",
        )}
      >
        <Pencil />
      </span>
      <textarea
        rows={1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={alone ? "Type your answer…" : "Other: type your own answer…"}
        aria-label={alone ? "Your answer" : "Other: your own answer"}
        className="field-sizing-content mt-px max-h-36 min-h-6 min-w-0 flex-1 resize-none bg-transparent text-base leading-snug text-text-primary outline-none placeholder:text-text-subtle disabled:cursor-default md:text-sm"
        data-card-other-input=""
      />
    </label>
  );
}
