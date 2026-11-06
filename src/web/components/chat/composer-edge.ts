/**
 * The line just above a chat's composer, for what has to sit there on a phone whatever else is
 * stacked between the transcript and the composer.
 *
 * The history window's Back to latest pill floats over the bottom of the transcript, but on a
 * phone the bars under the transcript (running agents, the session's file changes, a stop
 * notice) can push that bottom out of the thumb zone. So below `md` the pill is docked to a
 * zero-height element the chat tab places directly above the composer instead, at a fixed offset
 * from it. Without that element (or above `md`) it stays in the window.
 */
import { createContext, useContext } from "react";
import { useIsMobile } from "@/hooks/use-is-mobile";

export const ComposerEdgeContext = createContext<HTMLElement | null>(null);

/** Where the pill docks: the composer's edge on a phone, else null (in the window). */
export function usePillDock(): HTMLElement | null {
  const edge = useContext(ComposerEdgeContext);
  const isMobile = useIsMobile();
  return isMobile ? edge : null;
}
