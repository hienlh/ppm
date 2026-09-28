import { Sparkles, Info } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { useOnboardingStore } from "@/stores/onboarding-store";
import { useProjectStore } from "@/stores/project-store";
import { openQuickOrientation } from "./onboarding-quick-orientation";

/** Reopening guidance never changes the workspace or the user's drafts. */
export function OnboardingEntry({ compact = false }: { compact?: boolean }) {
  const state = useOnboardingStore();
  const projectName = useProjectStore((s) => s.activeProject?.name);
  const canResume = state.goal && state.familiarity && state.status !== "finished";
  const buttonClass = "h-11 can-hover:h-7 min-w-0 gap-1.5 rounded px-2 py-0 text-xs font-normal text-text-secondary shadow-none hover:bg-surface-elevated/60 hover:text-foreground active:bg-surface-elevated focus-visible:ring-2 focus-visible:ring-primary/50 motion-reduce:transition-none whitespace-nowrap";
  return <div role="group" aria-label="Learn PPM" className={`${compact ? "justify-center" : "justify-start"} max-w-full inline-flex flex-wrap items-center gap-x-1 gap-y-0`}>
    <Button variant="ghost" className={buttonClass}
      onClick={() => canResume ? state.resume(projectName) : state.status === "finished" ? state.replay() : state.begin()}>
      <Sparkles aria-hidden className="size-3 shrink-0" />
      <span>{canResume ? "Resume guided tour" : state.status === "unseen" ? "Get started with PPM" : "Open guided tour"}</span>
    </Button>
    <span aria-hidden className="h-3 w-px shrink-0 bg-border" />
    <Button variant="ghost" className={buttonClass} onClick={openQuickOrientation}>
      <Info aria-hidden className="size-3 shrink-0" /><span>Quick orientation</span>
    </Button>
  </div>;
}
