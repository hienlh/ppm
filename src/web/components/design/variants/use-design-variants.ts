import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { pickDesignVariant } from "@/lib/design/api-designs";
import {
  designFrameKey, loadDesignViewPrefs, saveDesignViewPrefs, withoutVariant, withVariant,
} from "@/lib/design/design-view-prefs";
import { designVariantsOf, variantDisplayName, type DesignVariant } from "../../../../shared/design-variants";
import type { DesignTabContextValue } from "../design-tab-context";
import type { DesignBridge } from "../canvas/use-design-bridge";

/**
 * Which variant the canvas shows, and "Use this variant".
 *
 * Two hooks because the canvas needs the file before its bridge exists, and picking needs the
 * bridge: `useShownVariant` decides what to load, `useDesignVariants` adds the pick on top.
 *
 * The choice is remembered per design on this device and only trusted while the design still
 * lists that file: a variant removed by the agent, or by a pick on another device, falls back
 * to the entry page. Picking needs the gen the canvas loaded the variant with, so it is only
 * offered once the frame on screen reported `ready` for that very file, and never while the
 * design's chat is mid-turn — the agent could be rewriting the pages being deleted.
 */

export interface ShownVariant {
  list: DesignVariant[];
  /** The variant file on screen. */
  file: string;
  index: number;
  choose: (file: string) => void;
}

export interface DesignVariantsFeature extends ShownVariant {
  /** Two or more variants: only then is there anything to switch or pick. */
  multiple: boolean;
  nameOf: (index: number) => string;
  canPick: boolean;
  picking: boolean;
  confirmOpen: boolean;
  openConfirm: () => void;
  closeConfirm: () => void;
  pick: () => void;
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

export function useDesignVariants(tab: DesignTabContextValue, shown: ShownVariant, bridge: DesignBridge): DesignVariantsFeature {
  const { projectName, slug, isStreaming, refreshDesign } = tab;
  const { list, file, index, choose } = shown;
  // The variant the open confirmation names. If what is on screen changes under it (another
  // device picked, the agent removed a page), the dialog closes rather than keeping a
  // variant the user was never asked about.
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const ready = bridge.ready;
  const canPick = list.length > 1 && !isStreaming && !picking && ready?.file === file;
  const setConfirmOpen = useCallback((open: boolean) => setConfirmFor(open ? file : null), [file]);
  useEffect(() => {
    if (confirmFor !== null && confirmFor !== file && !picking) setConfirmFor(null);
  }, [confirmFor, file, picking]);

  const pick = useCallback(() => {
    if (!ready || ready.file !== file || confirmFor !== file || picking) return;
    const name = variantDisplayName(list[index]!, index);
    setPicking(true);
    pickDesignVariant(projectName, slug, { file, gen: ready.gen })
      .then((result) => {
        setConfirmOpen(false);
        choose(result.design.entry);
        refreshDesign();
        toast.success(`Kept ${name}`, { description: "The other variants were saved to Version history first." });
      })
      .catch((e: unknown) => toast.error("Could not keep this variant", { description: (e as Error).message }))
      .finally(() => setPicking(false));
  }, [ready, file, confirmFor, picking, list, index, projectName, slug, choose, refreshDesign, setConfirmOpen]);

  return useMemo(() => ({
    ...shown, multiple: list.length > 1,
    nameOf: (i: number) => (list[i] ? variantDisplayName(list[i]!, i) : ""),
    canPick, picking, confirmOpen: confirmFor !== null,
    openConfirm: () => setConfirmOpen(true),
    closeConfirm: () => { if (!picking) setConfirmOpen(false); },
    pick,
  }), [shown, list, canPick, picking, confirmFor, pick, setConfirmOpen]);
}
