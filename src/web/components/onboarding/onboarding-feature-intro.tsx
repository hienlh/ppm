/**
 * The tour's "PPM has new features" part: one step per feature, each answered with Turn on or
 * Turn off. It sits in the tour's own panel on desktop and in a bottom sheet below `md`. Closing
 * it without answering counts as "Later" for whatever is still unanswered (see
 * `feature-intros-store.ts` for the once-per-app-open rule).
 */
import { useEffect, useRef } from "react";
import { Sparkles, X } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { openSettings } from "@/components/settings/open-settings";
import { featureIntroSteps, useFeatureIntrosStore } from "@/stores/feature-intros-store";
import { featurePartAllowed } from "@/lib/onboarding/feature-intros-client";
import type { OnboardingStatus } from "@/lib/onboarding/onboarding-types";
import { FEATURE_INTROS_CHANGED_EVENT, type FeatureIntro, type FeatureIntrosChangedEvent } from "../../../shared/feature-intros";
import { OnboardingHint } from "./onboarding-hint";
import { OnboardingStepTransition } from "./onboarding-step-transition";

/**
 * Loads the pending features once per app open, and again whenever any device changes them. A
 * question put off on another tab or device is put off here too, with no skip of this one's own.
 */
export function useFeatureIntrosSync(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const store = useFeatureIntrosStore.getState;
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<Partial<FeatureIntrosChangedEvent> | undefined>).detail;
      if (detail?.change === "skip" && typeof detail.id === "string") store().skippedElsewhere(detail.id);
      void store().load();
    };
    void store().load();
    window.addEventListener(FEATURE_INTROS_CHANGED_EVENT, changed);
    return () => window.removeEventListener(FEATURE_INTROS_CHANGED_EVENT, changed);
  }, [enabled]);
}

/**
 * Whether the basic tour's own "Get started with PPM" offer stays off screen while this browser
 * has never seen the tour: it does for an install already in use, which still opens the tour from
 * its usual entry (`OnboardingEntry`). Nothing is offered until the server has said which kind of
 * install this is, so the offer never flashes up for someone it is not meant for.
 */
export function useTourOfferHidden(): boolean {
  return useFeatureIntrosStore((s) => !s.settled || s.view?.isExistingUser === true);
}

/** Whether the part shows now, given this browser's basic-tour status. */
export function useFeaturePartVisible(tourStatus: OnboardingStatus): boolean {
  const state = useFeatureIntrosStore();
  if (!state.view) return false;
  return featurePartAllowed({
    remaining: featureIntroSteps(state).remaining.length, isExistingUser: state.view.isExistingUser, tourStatus, closed: state.closed,
  });
}

function FeatureIntroStep({ intro, position, total }: { intro: FeatureIntro; position: number; total: number }) {
  const { busy, error, answer, later, close, hide } = useFeatureIntrosStore();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { panel.current?.focus(); }, [intro.id]);
  const headingId = `feature-intro-${intro.id}`;
  return <div ref={panel} role="dialog" aria-labelledby={headingId} tabIndex={-1} className="p-4 outline-none"
    onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); void close(); } }}>
    <div className="flex items-center gap-2">
      <p className="flex-1 min-w-0 flex items-center gap-2 text-[11px] uppercase tracking-widest text-primary font-medium">
        <Sparkles className="size-4 shrink-0" />PPM has new features{total > 1 ? ` · ${position} of ${total}` : ""}
      </p>
      <Button variant="ghost" className="min-h-11 min-w-11" aria-label="Close, ask me later" onClick={() => void close()}><X /></Button>
    </div>
    <h2 id={headingId} className="font-semibold text-base mt-1">{intro.title}</h2>
    <p className="text-sm text-text-secondary leading-relaxed mt-2">{intro.body}</p>
    {error && <p role="alert" className="text-sm text-destructive mt-2">{error}</p>}
    <div className="grid grid-cols-2 gap-2 mt-4">
      <Button className="min-h-11" disabled={busy} onClick={() => void answer(intro.id, "on")}>Turn on</Button>
      <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => void answer(intro.id, "off")}>Turn off</Button>
    </div>
    <Button variant="ghost" className="w-full min-h-11 mt-1" disabled={busy} onClick={() => void later(intro.id)}>Later</Button>
    {/* Deciding there is answering, so this hides the part without counting a skip. */}
    <Button variant="link" className="w-full min-h-11 text-xs" onClick={() => { hide(); openSettings("tools"); }}>
      Change single tools in Settings → Tools
    </Button>
  </div>;
}

/** The part itself; render only while {@link useFeaturePartVisible} says so. */
export function OnboardingFeatureIntro({ mobile }: { mobile: boolean }) {
  const state = useFeatureIntrosStore();
  const { steps, current } = featureIntroSteps(state);
  const restoreFocus = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  useEffect(() => () => { (restoreFocus.current as HTMLElement | null)?.focus?.(); }, []);
  if (!current) return null;
  const step = <FeatureIntroStep intro={current} position={steps.indexOf(current.id) + 1} total={steps.length} />;
  if (mobile) return <BottomSheet open onClose={() => void state.close()} zIndex={60}>{step}</BottomSheet>;
  return <OnboardingHint collapsed={false}>
    <OnboardingStepTransition stepKey={current.id} order={steps.indexOf(current.id) + 1}>{step}</OnboardingStepTransition>
  </OnboardingHint>;
}
