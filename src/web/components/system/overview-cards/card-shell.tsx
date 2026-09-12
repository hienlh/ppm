import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface CardShellProps {
  testId: string;
  /** Extra `data-*` the card publishes for tests, e.g. `data-available`. */
  data?: Record<string, string | number | boolean>;
  /** Present when this card has a Performance device to open. A card with no
   *  target — a host reporting no drives at all — stays a plain `div`, because a
   *  button that does nothing is worse than no button. */
  onOpen?: () => void;
  /** What the button announces. Required with `onOpen`: a button's name is
   *  otherwise computed from its contents, which here is the whole card
   *  ("CPU 6.9% 12th Gen Intel(R) Core(TM) i9-12900K"). */
  openLabel?: string;
  children: ReactNode;
}

/**
 * The frame every Overview card shares, and the click that opens its Performance
 * page. Extracted because all five cards had a byte-identical wrapper and this
 * adds a conditional element type to each of them.
 *
 * It is one button over the whole card rather than a small "details" affordance
 * in a corner: a 44px target is the mobile floor and the card is the thing the
 * reader is already pointing at. That does mean the heading inside it stops being
 * a navigable heading for a screen reader, which is why the name is given
 * explicitly instead of being read off the contents.
 */
export function CardShell({ testId, data, onOpen, openLabel, children }: CardShellProps) {
  const frame = "rounded-lg border border-border p-4 space-y-2";
  const attrs = { "data-testid": testId, ...data };

  if (!onOpen) return <div className={frame} {...attrs}>{children}</div>;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={openLabel}
      {...attrs}
      className={cn(
        frame,
        // `text-left` because a button centres its content, and `w-full` because
        // it is a grid item that would otherwise shrink to its content.
        "w-full text-left cursor-pointer transition-colors",
        "hover:bg-surface-hover hover:border-primary/40",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
      )}
    >
      {children}
    </button>
  );
}
