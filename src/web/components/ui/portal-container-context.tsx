import { createContext, useContext, type ReactNode } from "react";

/**
 * Shared portal target for every Radix/portal-based primitive under
 * `components/ui/`. `undefined` means "the document's default target" — Radix
 * primitives fall back to `document.body`, `mobile-bottom-sheet.tsx` falls
 * back to `#root`. Never pass `null`: Radix's `container` prop only applies
 * its own default when the value is `undefined`, and `null` renders no
 * portal at all.
 *
 * With no provider mounted, `usePortalContainer()` returns `undefined` and
 * every primitive behaves exactly as it did before this context existed.
 */
const PortalContainerContext = createContext<HTMLElement | undefined>(
  undefined,
);

/**
 * Mounts a portal target for all descendant Radix primitives. Pass
 * `undefined` to explicitly restore the document default (e.g. once a
 * picture-in-picture window closes).
 */
export function PortalContainerProvider({
  container,
  children,
}: {
  container: HTMLElement | undefined;
  children: ReactNode;
}) {
  return (
    <PortalContainerContext.Provider value={container}>
      {children}
    </PortalContainerContext.Provider>
  );
}

/** The caller-supplied portal container, or `undefined` outside any provider. */
export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext);
}
