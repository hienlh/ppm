/**
 * The choices a manager offers on a decision card, one button each, stacked: a number (the same
 * one Telegram shows), the label and what choosing it does. A press answers the card at once with
 * that choice; there is no second step, as with OK. Every button is at least the chip row's
 * height (28 px, 26 px on a phone), taller when its label and description need it.
 *
 * Once the card no longer waits the choices stay listed, the one the user picked marked, so the
 * card still says what was decided. A card whose choices cannot be pressed here (too long, or a
 * part was hidden as a secret) lists them without buttons and says how to answer instead.
 */
import { Check } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { escapeHiddenCharacters } from "../../../../shared/reveal-hidden-characters";
import type { CardOption } from "../../../../shared/assistant-cards";

export function CardChoices({ options, pressable, chosenId, disabled, onChoose }: {
  options: readonly CardOption[];
  /** The card waits and its whole decision is shown: each choice is a button. */
  pressable: boolean;
  /** The choice the card was answered with, if any. */
  chosenId?: string;
  /** An answer is on its way. */
  disabled: boolean;
  onChoose: (optionId: string) => void;
}) {
  return (
    <div className="space-y-1.5" data-card-choices="">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-subtle">
        {pressable ? "Choose one" : "Choices"}
      </p>
      <div role="group" aria-label="Choices" className="flex flex-col gap-1.5">
        {options.map((o, i) => {
          const chosen = o.id === chosenId;
          return (
            <button
              key={o.id}
              type="button"
              disabled={!pressable || disabled}
              onClick={() => onChoose(o.id)}
              aria-pressed={chosenId !== undefined ? chosen : undefined}
              className={cn(
                "flex min-h-7 max-md:min-h-[26px] w-full items-start gap-2.5 rounded-lg border px-3 py-1.5 text-left transition-colors disabled:cursor-default",
                chosen
                  ? "border-primary bg-accent-wash"
                  : "border-border bg-surface can-hover:enabled:hover:border-accent-wash-border can-hover:enabled:hover:bg-panel-2",
                !pressable && !chosen && "opacity-80",
              )}
              data-card-choice={o.id}
              data-chosen={chosen ? "" : undefined}
            >
              <span
                aria-hidden
                className={cn(
                  "mt-px grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold tabular-nums",
                  chosen ? "bg-primary text-primary-foreground" : "border border-border bg-panel-2 text-text-secondary",
                )}
              >
                {chosen ? <Check className="size-3.5" /> : i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block break-words text-sm font-medium leading-snug text-text-primary">{escapeHiddenCharacters(o.label)}</span>
                {o.description && (
                  <span className="mt-0.5 block break-words text-[13px] leading-relaxed text-text-secondary">{escapeHiddenCharacters(o.description)}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
