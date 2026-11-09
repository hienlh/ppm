/**
 * The parts the composer's `/` and `@` pickers share: the panel, the key-hint footer and the
 * match highlight.
 *
 * Floating, the panel is positioned against a `relative` box sitting directly above the composer
 * (see chat-tab.tsx): full width, 6px above it, over the context row rather than pushing it up,
 * with the footer popovers' surface and entry motion (`footer-pop-in`, off under reduced motion).
 * Static, it is an in-flow strip for a text box that is not a composer (the design-instructions
 * editor in Settings), where floating over the settings above would hide what is being edited.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * "Narrow or touch": the chat container below 420px, a phone, or a device with no fine hovering
 * pointer. Each rule only ever hides or enlarges, so the three cannot fight over one property.
 * Kept as literal class lists so Tailwind's scanner sees every one.
 */
export const HIDE_WHEN_NARROW_OR_TOUCH =
  "@max-[420px]/chat:hidden max-md:hidden [@media(hover:none)]:hidden [@media(pointer:coarse)]:hidden";

export function PickerPanel({ variant = "floating", label, header, footer, children }: {
  variant?: "floating" | "static";
  /** Accessible name of the list. */
  label: string;
  header: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      data-composer-picker={variant}
      // Keeps focus in the text box: a press on a row, a tab or Refresh would otherwise blur it,
      // which closes the phone's keyboard and, in Settings, the picker itself. `click` still fires.
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        "flex flex-col overflow-hidden text-xs text-text",
        variant === "floating"
          ? "popover-solid footer-pop-in absolute inset-x-0 bottom-full z-50 mb-1.5 max-h-[min(320px,55vh)] origin-bottom rounded-xl border border-border shadow-[var(--shadow-float)]"
          : "max-h-[340px] border-b border-border bg-surface",
      )}
    >
      {header}
      <div role="listbox" aria-label={label} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
        {children}
      </div>
      {footer}
    </div>
  );
}

/** The header line of a picker. */
export function PickerHeader({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border-soft py-1.5 pr-1.5 pl-2.5 max-md:py-2">
      {children}
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="mr-0.5 inline-grid h-4 min-w-4 place-items-center rounded border border-border-soft bg-panel px-1 font-sans text-[10px] font-medium text-text-2">
      {children}
    </kbd>
  );
}

/**
 * ↑↓ move · ↵ insert · Tab complete · Esc close — for a keyboard and a mouse only. Wraps rather
 * than clips, so a keycap is never cut in half.
 */
export function PickerKeyHints() {
  return (
    <div
      data-picker-key-hints=""
      className={cn(
        "flex min-h-[30px] shrink-0 flex-wrap items-center gap-x-3.5 gap-y-1 border-t border-border-soft px-3 py-1.5 text-[10.5px] leading-[18px] whitespace-nowrap text-text-3",
        HIDE_WHEN_NARROW_OR_TOUCH,
      )}
    >
      <span className="inline-flex items-center gap-0.5"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
      <span className="inline-flex items-center gap-0.5"><Kbd>↵</Kbd> insert</span>
      <span className="inline-flex items-center gap-0.5"><Kbd>Tab</Kbd> complete</span>
      <span className="inline-flex items-center gap-0.5"><Kbd>Esc</Kbd> close</span>
    </div>
  );
}

/**
 * `text` with the first case-insensitive occurrence of `query` marked: accent colour, semibold,
 * no background. A fuzzy match that is not a substring is shown unmarked rather than guessed at.
 */
export function HighlightMatch({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-transparent font-semibold text-primary">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}
