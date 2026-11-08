/**
 * Settings → Tools' NEW marker: the tools of a feature the tour switched off because it was put
 * off too many times. They are marked for this visit, and the visit itself counts as having seen
 * them, so the next one shows no marker.
 */
import { useEffect, useState } from "react";
import { featureIntroById } from "../../../shared/feature-intros";
import type { PpmTool } from "../../../shared/ppm-tools";
import { fetchFeatureIntros, postFeatureIntroSeenInSettings } from "@/lib/onboarding/feature-intros-client";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useNewFeatureTools(): ReadonlySet<PpmTool> {
  const [tools, setTools] = useState<ReadonlySet<PpmTool>>(() => new Set());
  useEffect(() => {
    let alive = true;
    fetchFeatureIntros()
      .then((view) => {
        if (!alive || !view || view.newInSettings.length === 0) return;
        setTools(new Set(view.newInSettings.flatMap((id) => featureIntroById(id)?.tools ?? [])));
        for (const id of view.newInSettings) {
          postFeatureIntroSeenInSettings(id).catch((e) => console.warn(`Could not record that ${id} was seen: ${errorText(e)}`));
        }
      })
      .catch((e) => console.warn(`Could not load the new-feature markers: ${errorText(e)}`));
    return () => { alive = false; };
  }, []);
  return tools;
}
