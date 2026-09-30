import { useCallback, useEffect, useMemo, useState } from "react";
import {
  designFrameKey, loadDesignViewPrefs, saveDesignViewPrefs, withoutVariant, withVariant,
} from "@/lib/design/design-view-prefs";
import { designVariantsOf, variantDisplayName, type DesignVariant } from "../../../../shared/design-variants";
import type { DesignTabContextValue } from "../design-tab-context";

/**
 * Which variant the canvas shows.
 *
 * Two hooks because the canvas needs the file before its bridge exists: `useShownVariant`
 * decides what to load, `useDesignVariants` adds the switcher's display names on top.
 * Keeping or dropping a variant is done by the agent in the design chat, not from the canvas.
 *
 * The choice is remembered per design on this device and only trusted while the design still
 * lists that file: a variant removed by the agent falls back to the entry page.
 */

export interface ShownVariant {
  list: DesignVariant[];
  /** The variant file on screen. */
  file: string;
  index: number;
  choose: (file: string) => void;
}

export interface DesignVariantsFeature extends ShownVariant {
  /** Two or more variants: only then is there anything to switch between. */
  multiple: boolean;
  nameOf: (index: number) => string;
}

export function useShownVariant(tab: DesignTabContextValue): ShownVariant {
  const key = designFrameKey(tab.projectName, tab.slug);
  const [chosen, setChosen] = useState<string | null>(() => loadDesignViewPrefs().variants[key] ?? null);
  const list = useMemo(() => designVariantsOf(tab.design), [tab.design]);
  const found = list.findIndex((v) => v.file === chosen);
  const index = found === -1 ? 0 : found;
  const choose = useCallback((next: string) => {
    setChosen(next);
    saveDesignViewPrefs(withVariant(loadDesignViewPrefs(), key, next));
  }, [key]);
  // A remembered variant the design no longer lists is forgotten, not just skipped: a later
  // turn that writes a new `variant-2.html` is a different direction, and must not open on
  // its own because an old choice happened to have the same name. Not mid-turn, when the
  // agent may list a page a moment before the page itself is written.
  const { isStreaming } = tab;
  useEffect(() => {
    if (chosen === null || found !== -1 || isStreaming) return;
    setChosen(null);
    saveDesignViewPrefs(withoutVariant(loadDesignViewPrefs(), key));
  }, [chosen, found, isStreaming, key]);
  return useMemo(() => ({ list, file: list[index]!.file, index, choose }), [list, index, choose]);
}

export function useDesignVariants(shown: ShownVariant): DesignVariantsFeature {
  const { list } = shown;
  return useMemo(() => ({
    ...shown, multiple: list.length > 1,
    nameOf: (i: number) => (list[i] ? variantDisplayName(list[i]!, i) : ""),
  }), [shown, list]);
}
