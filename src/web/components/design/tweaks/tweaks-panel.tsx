import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, RotateCcw, Sparkles, SlidersHorizontal, X } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { deliverToDesignChat } from "@/lib/design/deliver-to-design-chat";
import { buildAddTweaksPrompt, buildFixTweaksPrompt, shownValue } from "@/lib/design/design-tweaks-model";
import { TweakControl } from "./tweak-control";
import type { DesignTweaksFeature } from "./use-design-tweaks";

/**
 * The Tweaks panel: one control per tweak `design.json` declares, live on the canvas as
 * they move, written to the design only on Apply. A desktop side column; on a phone the
 * same body sits in a bottom sheet with Reset and Apply at its foot, in the thumb zone.
 *
 * Skipped entries are counted in a badge that unfolds their reasons, with a way to hand
 * them to the AI; a design with no tweaks at all offers to ask the AI for some. Neither
 * sends anything: the brief lands in the design chat's composer for the user to send.
 */

export function TweaksPanel({ feature, tabId, slug }: { feature: DesignTweaksFeature; tabId: string; slug: string }) {
  const [showErrors, setShowErrors] = useState(false);
  const { info, loadError, rendered, edits, winners, overridden } = feature;
  const errors = info?.errors ?? [];
  const tweaks = info?.tweaks ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <SlidersHorizontal className="size-4 text-text-subtle" />
        <span className="flex-1 text-xs font-semibold">Tweaks</span>
        <button type="button" onClick={feature.closePanel} aria-label="Close tweaks"
          className="flex size-11 items-center justify-center rounded-md text-text-subtle hover:bg-surface-elevated md:size-7">
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {loadError ? (
          <p className="p-3 text-xs text-destructive">{loadError}</p>
        ) : info === null ? (
          <div className="flex justify-center py-6"><Loader2 className="size-4 animate-spin text-primary" /></div>
        ) : (
          <>
            {errors.length > 0 && (
              <div className="mx-2 mb-1 rounded-md border border-warning/40 bg-warning/10">
                <button type="button" onClick={() => setShowErrors((v) => !v)} aria-expanded={showErrors}
                  className="flex min-h-11 w-full items-center gap-1 px-2 text-left text-xs font-medium text-warning md:min-h-8">
                  {showErrors ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                  <AlertTriangle className="size-3.5" />
                  {errors.length === 1 ? "1 tweak ignored" : `${errors.length} tweaks ignored`}
                </button>
                {showErrors && (
                  <div className="px-3 pb-2">
                    <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-text-subtle">
                      {errors.map((e, i) => <li key={i} className="break-words">{e}</li>)}
                    </ul>
                    <button type="button" onClick={() => deliverToDesignChat(tabId, buildFixTweaksPrompt(slug, errors), "Fix tweaks")}
                      className="mt-1 min-h-11 text-xs text-primary underline md:min-h-7">Ask AI to fix them</button>
                  </div>
                )}
              </div>
            )}
            {tweaks.length === 0 ? (
              <div className="flex flex-col items-start gap-2 p-3">
                <p className="text-xs leading-relaxed text-text-subtle">
                  This design declares no tweaks yet. Tweaks are sliders, colours and choices bound to the design's CSS variables.
                </p>
                <Button variant="outline" className="min-h-11 md:min-h-8"
                  onClick={() => deliverToDesignChat(tabId, buildAddTweaksPrompt(slug), "Add tweaks")}>
                  <Sparkles className="size-4" /> Ask AI to add tweaks
                </Button>
              </div>
            ) : (
              tweaks.map((def) => (
                <TweakControl key={def.id} def={def} value={shownValue(def, edits, rendered)} winner={winners[def.var]}
                  overridden={overridden.includes(def.var)} onChange={(v) => feature.setValue(def.var, v)} />
              ))
            )}
          </>
        )}
      </div>
      {tweaks.length > 0 && (
        <div className="shrink-0 border-t border-border p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {feature.isStreaming && feature.dirtyCount > 0 && (
            <p className="px-1 pb-1 text-xs text-text-subtle">Apply is available once the AI finishes its turn.</p>
          )}
          <div className="flex gap-2">
            <Button variant="outline" className="min-h-11 flex-1 md:min-h-9" onClick={feature.reset}
              disabled={Object.keys(edits).length === 0 || feature.applying}>
              <RotateCcw className="size-4" /> Reset
            </Button>
            <Button className="min-h-11 flex-1 md:min-h-9" onClick={feature.apply} disabled={!feature.canApply}>
              {feature.applying ? <Loader2 className="size-4 animate-spin" /> : null}
              {feature.dirtyCount > 1 ? `Apply ${feature.dirtyCount}` : "Apply"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
