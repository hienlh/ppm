/**
 * A card label that carries an explanation.
 *
 * The trigger is a button rather than a span on purpose. Radix opens a tooltip on focus as
 * well as hover, so tapping the chip reaches the explanation on touch, where hover does not
 * exist at all — `docs/design-guidelines.md` rules out hiding anything behind hover alone.
 * The visible label still carries the information; this only makes the reasoning behind it
 * reachable on every device rather than on desktop only.
 */

import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export interface AccountHintProps {
  hint: ReactNode;
  className?: string;
  children: ReactNode;
  /**
   * Makes the chip an action as well as an explanation — "Sign in again" should do what it
   * says rather than only describe it. The tooltip still opens on hover/focus.
   */
  onClick?: () => void;
}

export function AccountHint({ hint, className, children, onClick }: AccountHintProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className={[
            // The invisible `after` box stretches the touch target to ~44px without growing
            // the card header the chip sits in.
            onClick
              ? "relative cursor-pointer rounded px-1 -mx-1 underline decoration-dotted underline-offset-2 hover:bg-error/10 after:absolute after:-inset-x-2 after:-inset-y-3 after:content-['']"
              : "cursor-help",
            "text-left",
            className,
          ].filter(Boolean).join(" ")}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[260px] text-xs leading-relaxed">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}
