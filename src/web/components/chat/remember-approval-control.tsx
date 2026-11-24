/**
 * "Allow & remember" on an approval card: allows this request and makes PPM approve the same kind
 * by itself from then on, in this project (`remembered-approvals/`). What "the same kind" is was
 * worked out by the server and is said on the button's line, so the user knows exactly what they
 * agree to. After the user allowed the same kind by hand enough times, the card suggests it — and
 * still remembers nothing until it is pressed.
 *
 * The button is a button with text, so it takes the chat footer's chip size (design guidelines,
 * Mobile-First rule 3): 28px on desktop, 26px on a phone, with no taller variant for touch.
 */
import { Lightbulb, ShieldCheck } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { TEXT_BUTTON } from "@/lib/control-size";
import { REMEMBER_SUGGEST_AFTER, type CardRememberOffer } from "../../../shared/remembered-approvals";

export function RememberApprovalControl({ offer, disabled, onRemember, className }: {
  offer: CardRememberOffer;
  disabled?: boolean;
  onRemember: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn("space-y-1.5 rounded-md border px-2.5 py-2", offer.suggest ? "border-primary/50 bg-primary/10" : "border-border", className)}
      data-remember-offer={offer.suggest ? "suggest" : "offer"}
    >
      {offer.suggest && (
        <p className="flex items-start gap-1.5 text-xs font-medium text-primary">
          <Lightbulb className="mt-px size-3.5 shrink-0" />
          You have allowed this {REMEMBER_SUGGEST_AFTER} times. Remember it?
        </p>
      )}
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <button
          type="button"
          disabled={disabled}
          onClick={onRemember}
          className={cn(
            "inline-flex shrink-0 items-center justify-center self-start whitespace-nowrap font-medium transition-colors disabled:opacity-50 [&_svg]:size-3.5",
            TEXT_BUTTON,
            offer.suggest ? "bg-primary text-white can-hover:hover:bg-primary/80" : "border border-success/60 text-success can-hover:hover:bg-success/10",
          )}
        >
          <ShieldCheck />Allow &amp; remember
        </button>
        <p className="min-w-0 break-words text-xs text-text-secondary">
          Next time PPM approves this by itself, in this project: <b className="font-medium text-text-primary">{offer.label}</b>
        </p>
      </div>
    </div>
  );
}
