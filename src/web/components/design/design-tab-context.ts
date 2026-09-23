import { createContext, useContext } from "react";
import type { DesignSummary } from "../../../shared/design-types";

/**
 * What every part of a design tab shares: which design, which tab, which session, and the
 * few tab-level actions the canvas and toolbar need (bring the chat into view, refetch the
 * manifest).
 */
export interface DesignTabContextValue {
  projectName: string;
  slug: string;
  tabId: string;
  design: DesignSummary;
  /** The session the embedded chat is on, or null before its first message. */
  sessionId: string | null;
  /** True while that session's turn is running; restoring history waits for it. */
  isStreaming: boolean;
  /** True while this tab is the visible tab of its panel. */
  isActive: boolean;
  isMobile: boolean;
  showChat: () => void;
  refreshDesign: () => void;
}

export const DesignTabContext = createContext<DesignTabContextValue | null>(null);

export function useDesignTab(): DesignTabContextValue {
  const value = useContext(DesignTabContext);
  if (!value) throw new Error("useDesignTab() used outside a design tab");
  return value;
}
