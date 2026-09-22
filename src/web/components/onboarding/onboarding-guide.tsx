import { useState } from "react";
import { Check, ChevronDown, ChevronUp, X } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { useOnboardingStore } from "@/stores/onboarding-store";
import { getOnboardingCopy } from "@/lib/onboarding/onboarding-copy";
import { getOnboardingSteps } from "@/lib/onboarding/onboarding-steps";
import type { OnboardingStepId } from "@/lib/onboarding/onboarding-types";
import { openQuickOrientation } from "./onboarding-quick-orientation";
import { OnboardingFileHelp } from "./onboarding-file-help";

export function OnboardingGuide({ collapsed, setCollapsed, onAction, onSettings }: {
  collapsed: boolean; setCollapsed: (value: boolean) => void; onAction: (step: OnboardingStepId) => void; onSettings: () => void;
}) {
  const state = useOnboardingStore();
  const [more, setMore] = useState(false);
  const steps = getOnboardingSteps(state.goal);
  const step = state.currentStep;
  if (!step) return null;
  const copy = getOnboardingCopy(step, state.familiarity ?? "beginner");
  const index = steps.indexOf(step);
  return <div className="p-4">
    <div className="flex items-center gap-2">
      <div className="flex-1 min-w-0"><p className="text-[11px] uppercase tracking-widest text-primary font-medium">Guided tour · {index + 1} of {steps.length}</p><h2 className="font-semibold text-sm mt-1" aria-live="polite">{copy.title}</h2></div>
      <Button variant="ghost" className="min-h-11 min-w-11" aria-label={collapsed ? "Expand guide" : "Collapse guide"} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <ChevronUp /> : <ChevronDown />}</Button>
      <Button variant="ghost" className="min-h-11 min-w-11" aria-label="Pause tour" onClick={state.pause}><X /></Button>
    </div>
    {!collapsed && <>
      <div className="flex gap-1 mt-3 mb-4" aria-label="Tour progress">{steps.map((id) => <span key={id} className={`h-1 flex-1 rounded-full ${state.completed.includes(id) ? "bg-primary" : state.skipped.includes(id) ? "bg-text-subtle" : "bg-border"}`} />)}</div>
      <p className="text-sm text-text-secondary leading-relaxed">{copy.body}</p>
      {step === "file" && <OnboardingFileHelp />}
      {step === "run" && <p className="text-xs text-text-secondary mt-2">Open README directly, or package.json if no README is available. README Preview counts too.</p>}
      {step === "run" && state.runDocumentReady && <p className="text-sm text-primary mt-2 flex items-center gap-1"><Check className="size-4" />Run instructions opened</p>}
      <Button className="w-full mt-4 min-h-11" onClick={() => onAction(step)}>{step === "run" && state.runDocumentReady ? "I know where to run commands" : copy.action}</Button>
      {(step === "chat" || step === "send") && <Button variant="ghost" className="w-full min-h-11 mt-1" onClick={onSettings}>AI settings</Button>}
      <button className="text-xs text-primary py-3 min-h-11" onClick={() => setMore(!more)} aria-expanded={more}>{more ? "Less explanation" : "Explain this step"}</button>
      {more && <p className="text-sm text-text-secondary leading-relaxed mb-3">{copy.more}</p>}
      <Button variant="link" className="w-full min-h-11" onClick={openQuickOrientation}>Quick orientation</Button>
      <div className="flex items-center justify-between border-t border-border pt-2">
        <Button variant="ghost" className="min-h-11 px-2" disabled={index === 0} onClick={state.back}>Back</Button>
        <Button variant="ghost" className="min-h-11 px-2" onClick={state.changeChoices}>Change guide</Button>
        <Button variant="ghost" className="min-h-11 px-2" onClick={state.skip}>Skip step</Button>
      </div>
    </>}
  </div>;
}
