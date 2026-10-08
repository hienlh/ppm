import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  initialDesignPane, nextAutoSplit, resolveDesignLayout, type DesignLayoutOverride, type DesignPane,
} from "@/lib/design/design-layout-mode";
import { loadDesignViewPrefs, saveDesignViewPrefs, withLayout } from "@/lib/design/design-view-prefs";
import type { DesignLayoutControls } from "./design-tab-context";

/**
 * The design tab's layout state: the user's pick, the pane shown in single-pane mode, the
 * expanded canvas, and auto mode's answer for the tab's own width.
 *
 * `rootRef` goes on the tab's layout root. It is measured in a layout effect, so a tab that
 * opens narrow paints single-pane on its first frame instead of flashing a split.
 */
export function useDesignLayout({ isPhone, isActive, windowed = false }: { isPhone: boolean; isActive: boolean; windowed?: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [override, setOverrideState] = useState<DesignLayoutOverride>(() => loadDesignViewPrefs().layout);
  const [pane, setPane] = useState<DesignPane>(() => initialDesignPane(override));
  const [autoSplit, setAutoSplit] = useState(true);
  const [expanded, setExpanded] = useState(false);
  // A window opens with its chat column showing; closing it is a choice for this window only.
  const [windowChat, setWindowChat] = useState(true);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = (width: number) => setAutoSplit((was) => nextAutoSplit(width, was));
    measure(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => { if (entry) measure(entry.contentRect.width); });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A full-window canvas belongs to the tab on screen; switching away must not leave it
  // covering whatever tab comes up next once this one is shown again.
  useEffect(() => {
    if (!isActive) setExpanded(false);
  }, [isActive]);

  const setOverride = useCallback((next: DesignLayoutOverride) => {
    setOverrideState(next);
    if (next === "canvas" || next === "chat") setPane(next);
    saveDesignViewPrefs(withLayout(loadDesignViewPrefs(), next));
  }, []);

  const showChat = useCallback(() => {
    setExpanded(false);
    setPane("chat");
    setWindowChat(true);
  }, []);

  const layout = useMemo<DesignLayoutControls>(() => ({
    ...resolveDesignLayout({ override, isPhone, autoSplit, pane, expanded, windowed, windowChat }),
    setOverride, setPane, setExpanded, setWindowChat,
  }), [override, isPhone, autoSplit, pane, expanded, windowed, windowChat, setOverride]);

  return { rootRef, layout, showChat };
}
