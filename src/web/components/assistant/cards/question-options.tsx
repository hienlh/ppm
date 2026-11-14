/**
 * A question's options as tiles: a letter (A, B, C…), the label, a "Recommended" tag where the
 * label carried "(Recommended)", and the whole description under it — descriptions are where a
 * manager explains the trade-off, so they are never cut. One choice per question unless the
 * question allows several (round marks vs square). Every tile is at least 44 px tall.
 */
import { Check } from "@/lib/icons";
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

export function QuestionOptions({ label, options, multi, chosen, disabled, onPick }: {
  /** The question, for screen readers. */
  label: string;
  options: ReadonlyArray<{ label: string; description?: string }>;
  multi: boolean;
  chosen: readonly string[];
  disabled: boolean;
  onPick: (label: string) => void;
}) {
  return (
    <div role={multi ? "group" : "radiogroup"} aria-label={label} className="mt-2 space-y-1.5" data-card-options="">
      {options.map((o, i) => {
        const on = chosen.includes(o.label);
        const { text, recommended } = splitRecommended(o.label);
        return (
          <button
            key={o.label}
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
    </div>
  );
}
