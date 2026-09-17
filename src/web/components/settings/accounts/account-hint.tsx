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
}

export function AccountHint({ hint, className, children }: AccountHintProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className={["cursor-help text-left", className].filter(Boolean).join(" ")}>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[260px] text-xs leading-relaxed">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}
