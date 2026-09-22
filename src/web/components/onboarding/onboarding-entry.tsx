import { Sparkles } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { useOnboardingStore } from "@/stores/onboarding-store";
import { useProjectStore } from "@/stores/project-store";
import { openQuickOrientation } from "./onboarding-quick-orientation";

/** Reopening guidance never changes the workspace or the user's drafts. */
export function OnboardingEntry({ compact = false }: { compact?: boolean }) {
  const state = useOnboardingStore();
  const projectName = useProjectStore((s) => s.activeProject?.name);
  const canResume = state.goal && state.familiarity && state.status !== "finished";
  return <div className={compact ? "flex flex-wrap items-center gap-2" : "grid gap-2"}><Button variant="outline" className={compact ? "min-h-11" : "min-h-11 w-full"}
    onClick={() => canResume ? state.resume(projectName) : state.status === "finished" ? state.replay() : state.begin()}><Sparkles className="size-4" />{canResume ? "Resume guided tour" : state.status === "unseen" ? "Get started with PPM" : "Open guided tour"}</Button>
    <Button variant="link" className="min-h-11" onClick={openQuickOrientation}>Quick orientation</Button></div>;
}
