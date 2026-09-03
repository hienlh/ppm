/**
 * Merges the props a parent injects into a row with the row's own props.
 *
 * Radix's `ContextMenuTrigger asChild` clones its child and merges `ref`, `onContextMenu`,
 * `onPointerDown`, `onPointerMove`, `onPointerUp`, `onPointerCancel`, `data-state`,
 * `data-disabled` and `style={{ WebkitTouchCallout: "none", … }}` onto it. When the child is
 * a custom component rather than a DOM element, those land in its props object and a fixed
 * destructuring list silently drops every one it does not name — which is how the injected
 * `style` (the only thing suppressing the native long-press callout on iOS) and Radix's own
 * pointer-based long-press fallback disappeared before reaching the real `<div>`.
 *
 * Rules, in the order a row needs them:
 * - two handlers for the same event chain, injected first, so the parent's behaviour (open
 *   the menu) happens before the row's own (select, then stop the event travelling further);
 * - `style` and `className` merge, with the row's own values winning per key;
 * - anything else defined by the row wins outright.
 */

import { cn } from "@/lib/utils";
import type { EntryRowDndProps } from "../dnd/use-entry-row-dnd";

type RowProps = Record<string, unknown>;

/**
 * The two props every row/tile adds on top of whatever Radix injects: the drag-and-drop
 * handler bag from `useEntryRowDnd`, and whether this row is the currently claimed drop
 * target (draws `DROP_TARGET_CLASS`).
 *
 * Deliberately *not* `extends Record<string, unknown>` — React's `PropsWithoutRef<P>` picks
 * over `keyof P`, and an index signature widens that to `string | number`, which collapses
 * every other named property's type to `unknown` for any component using this as its props
 * type. Radix's own injected props (`onContextMenu`, pointer handlers, `data-state`, `style`,
 * …) still land in the `...rest` destructured alongside this — object rest/spread copies
 * every own enumerable property at runtime regardless of what the static type declares, so
 * they are forwarded correctly whether or not the type says so.
 */
export interface InjectedRowProps {
  dnd: EntryRowDndProps;
  dropActive: boolean;
}

type Handler = (event: unknown) => void;

function isHandlerKey(key: string): boolean {
  return key.startsWith("on") && key.length > 2 && key[2] === key[2]?.toUpperCase();
}

function chain(first: unknown, second: unknown): Handler {
  return (event) => {
    (first as Handler | undefined)?.(event);
    (second as Handler | undefined)?.(event);
  };
}

export function composeInteractiveRowProps<P extends RowProps>(injected: P | undefined, own: P): P {
  if (!injected) return own;
  const merged: RowProps = { ...injected };

  for (const [key, value] of Object.entries(own)) {
    const existing = merged[key];
    if (isHandlerKey(key) && typeof existing === "function" && typeof value === "function") {
      merged[key] = chain(existing, value);
      continue;
    }
    if (key === "style" && existing && value) {
      merged[key] = { ...(existing as object), ...(value as object) };
      continue;
    }
    if (key === "className") {
      merged[key] = cn(existing as string | undefined, value as string | undefined);
      continue;
    }
    if (value !== undefined) merged[key] = value;
  }

  return merged as P;
}
