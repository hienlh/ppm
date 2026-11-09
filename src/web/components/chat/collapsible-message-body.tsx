/**
 * The body of a message bubble, clamped to two lines until the reader asks for the rest.
 *
 * Shared by the person's own bubble and the bubble another session's AI sent, so both fold the
 * same way at the same threshold. "Show more" appears only when the clamp actually hides
 * something: the body is measured, not guessed from its length, because a short message with one
 * long unbroken line overflows while a long one made of short lines may not.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "@/lib/icons";
import { cn } from "@/lib/utils";

export function CollapsibleMessageBody({ watch, className, toggleClassName, children }: {
  /** What the body shows; it is measured again whenever this changes. */
  watch: unknown;
  /** Classes for the clamped container itself. */
  className?: string;
  /** Colour classes for the Show more / Show less button. */
  toggleClassName?: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const check = () => setIsOverflowing(el.scrollHeight > el.clientHeight + 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [watch]);

  return (
    <>
      <div
        ref={contentRef}
        data-message-clamp={expanded ? "expanded" : "collapsed"}
        className={cn(
          "transition-all duration-200",
          !expanded && "line-clamp-2",
          expanded && "max-h-[50vh] overflow-y-auto",
          className,
        )}
      >
        {children}
      </div>
      {(isOverflowing || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className={cn("flex items-center gap-1 text-xs mt-1 transition-colors", toggleClassName)}
        >
          {expanded ? <><ChevronUp className="size-3" />Show less</> : <><ChevronDown className="size-3" />Show more</>}
        </button>
      )}
    </>
  );
}
