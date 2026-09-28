import { useRef, useState } from "react";
import { Sparkles, Code, MessageSquare, ArrowLeft } from "@/lib/icons";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useOnboardingStore } from "@/stores/onboarding-store";
import type { OnboardingFamiliarity, OnboardingGoal } from "@/lib/onboarding/onboarding-types";
import { OnboardingStepTransition } from "./onboarding-step-transition";

const levels: Array<{ id: OnboardingFamiliarity; title: string; body: string; icon: typeof Sparkles }> = [
  { id: "beginner", title: "I'm just getting started", body: "One step at a time, with the basics explained.", icon: Sparkles },
  { id: "familiar", title: "I've used similar tools", body: "A quick introduction to finding your way around PPM.", icon: Sparkles },
  { id: "advanced", title: "I'm a developer / advanced user", body: "Go straight to the workspace and tools.", icon: Code },
];
const goals: Array<{ id: OnboardingGoal; title: string; body: string; icon: typeof Sparkles }> = [
  { id: "ai", title: "Work with AI", body: "Ask about a project and find your conversation again.", icon: MessageSquare },
  { id: "explore", title: "Explore a project", body: "Open a file and search through your project.", icon: Sparkles },
  { id: "developer", title: "Use development tools", body: "Find the terminal, Git changes and run instructions.", icon: Code },
];

export function OnboardingSetup({ projectName }: { projectName?: string }) {
  const store = useOnboardingStore();
  const opener = useRef(document.activeElement as HTMLElement | null);
  const [screen, setScreen] = useState<"level" | "goal">("level");
  return <Dialog open onOpenChange={(open) => { if (!open) store.dismiss(); }}>
    <DialogContent onCloseAutoFocus={(event) => {
      event.preventDefault();
      const target = opener.current?.isConnected ? opener.current : document.querySelector<HTMLElement>('aside[aria-label="PPM guided tour"] button');
      target?.focus();
    }} className="max-h-[90dvh] overflow-y-auto sm:max-w-[520px] p-5 sm:p-7">
      <OnboardingStepTransition stepKey={screen} order={screen === "level" ? 0 : 1} className="grid gap-4">
      <div className="text-xs font-medium tracking-widest uppercase text-primary">Your first steps · {screen === "level" ? "1" : "2"} of 2</div>
      <DialogTitle className="text-2xl leading-tight">{screen === "level" ? "Make PPM feel familiar" : "What would you like to do first?"}</DialogTitle>
      <DialogDescription>{screen === "level" ? "Choose the amount of guidance that suits you. You can change this anytime." : "Every path is available to you. Start with something useful."}</DialogDescription>
      <div className="grid gap-3 mt-1">
        {screen === "level" ? levels.map(({ id, title, body, icon: Icon }) =>
          <button key={id} onClick={() => { store.chooseFamiliarity(id); setScreen("goal"); }} className="flex items-start gap-4 rounded-lg border border-border bg-surface p-4 text-left hover:border-primary focus-visible:outline-2 focus-visible:outline-primary">
            <Icon className="size-5 shrink-0 text-primary mt-0.5" /><span><span className="block font-medium text-sm">{title}</span><span className="block mt-1 text-sm text-text-secondary">{body}</span></span>
          </button>) : goals.map(({ id, title, body, icon: Icon }) =>
          <button key={id} onClick={() => { store.chooseGoal(id); store.start(projectName); }} className="flex items-start gap-4 rounded-lg border border-border bg-surface p-4 text-left hover:border-primary focus-visible:outline-2 focus-visible:outline-primary">
            <Icon className="size-5 shrink-0 text-primary mt-0.5" /><span><span className="block font-medium text-sm">{title}{id === "ai" && <span className="ml-2 text-xs text-primary">Suggested</span>}</span><span className="block mt-1 text-sm text-text-secondary">{body}</span></span>
          </button>)}
      </div>
      <div className="flex items-center justify-between">
        {screen === "goal" ? <Button variant="ghost" className="min-h-11" onClick={() => setScreen("level")}><ArrowLeft />Back</Button> : <span />}
        <Button variant="ghost" className="min-h-11 text-text-secondary" onClick={store.dismiss}>I'll explore on my own</Button>
      </div>
      </OnboardingStepTransition>
    </DialogContent>
  </Dialog>;
}
