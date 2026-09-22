import { useEffect, useState } from "react";
import { Sparkles } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { useOnboardingStore } from "@/stores/onboarding-store";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore, type SidebarActiveTab } from "@/stores/settings-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { openSettings } from "@/components/settings/open-settings";
import { ONBOARDING_EVENT, type OnboardingEvent, type OnboardingStepId } from "@/lib/onboarding/onboarding-types";
import { ONBOARDING_TARGETS, getOnboardingSteps } from "@/lib/onboarding/onboarding-steps";
import { OnboardingStepTransition } from "./onboarding-step-transition";
import { ONBOARDING_SUGGESTED_PROMPT } from "@/lib/onboarding/onboarding-copy";
import { OnboardingSetup } from "./onboarding-setup";
import { OnboardingGuide } from "./onboarding-guide";
import { findTourTarget, OnboardingHint } from "./onboarding-hint";
import { useOnboardingSessionCheck } from "./use-onboarding-session-check";
import { OPEN_QUICK_ORIENTATION, OnboardingQuickOrientation } from "./onboarding-quick-orientation";
import { openCommandPalette } from "@/hooks/use-global-keybindings";
import { openRunInstructions } from "@/lib/onboarding/run-instructions";

export function OnboardingRoot({ openProjects, openNavigation, closeNavigation, paletteOpen = false, navigationOpen = false }: {
  openProjects: () => void; openNavigation: (tab: SidebarActiveTab) => void; closeNavigation: () => void; paletteOpen?: boolean; navigationOpen?: boolean;
}) {
  const state = useOnboardingStore();
  const project = useProjectStore((s) => s.activeProject);
  const mobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(false);
  const [notice, setNotice] = useState("");
  const [orientationOpen, setOrientationOpen] = useState(false);
  useEffect(() => {
    const open = () => setOrientationOpen(true);
    window.addEventListener(OPEN_QUICK_ORIENTATION, open);
    return () => window.removeEventListener(OPEN_QUICK_ORIENTATION, open);
  }, []);
  useOnboardingSessionCheck(setNotice);
  useEffect(() => {
    const receive = (event: Event) => useOnboardingStore.getState().observe((event as CustomEvent<OnboardingEvent>).detail);
    window.addEventListener(ONBOARDING_EVENT, receive);
    return () => window.removeEventListener(ONBOARDING_EVENT, receive);
  }, []);
  useEffect(() => { state.setProjectContext(project?.name ?? null); }, [project?.name, state.setProjectContext]);
  useEffect(() => {
    if (state.status !== "active") return;
    setNotice("");
    setCollapsed(false);
    const timer = window.setTimeout(() => window.dispatchEvent(new Event("ppm:onboarding-refresh")), 50);
    return () => clearTimeout(timer);
  }, [state.status, state.currentStep]);
  useEffect(() => {
    if (state.status !== "active" || orientationOpen || paletteOpen) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) useOnboardingStore.getState().pause(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [state.status, orientationOpen, paletteOpen]);

  function navigate(tab: SidebarActiveTab) {
    if (mobile) { openNavigation(tab); setCollapsed(true); }
    else {
      const settings = useSettingsStore.getState();
      if (settings.sidebarCollapsed) settings.toggleSidebar();
      settings.setSidebarActiveTab(tab);
    }
  }
  function openWorkTab(type: "chat" | "terminal") {
    if (!project) { state.setProjectContext(null); return; }
    closeNavigation();
    const tabs = useTabStore.getState();
    const active = tabs.tabs.find((tab) => tab.id === tabs.activeTabId && tab.type === type && tab.projectId === project.name);
    if (!active) tabs.openTab({ type, title: type === "chat" ? "New Chat" : `Terminal - ${project.name}`, projectId: project.name, metadata: { projectName: project.name }, closable: true });
    window.setTimeout(() => window.dispatchEvent(new Event("ppm:onboarding-refresh")), 50);
    if (mobile) setCollapsed(true);
  }
  function action(step: OnboardingStepId) {
    if (step === "project") {
      if (mobile) { openProjects(); setCollapsed(true); }
      else {
        const settings = useSettingsStore.getState();
        if (settings.sidebarCollapsed) settings.toggleSidebar();
        window.setTimeout(() => findTourTarget("project")?.click(), 0);
      }
    } else if (step === "run") {
      if (!project) { setNotice("Choose a project first, or skip this step."); return; }
      if (state.runDocumentReady) { state.observe({ type: "run-acknowledged", projectName: project.name, visible: true }); return; }
      const projectName = project.name;
      const stillCurrent = () => {
        const current = useOnboardingStore.getState();
        return current.status === "active" && current.currentStep === "run" && current.projectName === projectName && useProjectStore.getState().activeProject?.name === projectName;
      };
      setNotice("Looking for README or package.json…");
      void openRunInstructions(projectName, stillCurrent).then((result) => {
        if (!stillCurrent()) return;
        if (result === "missing") setNotice("No README or package.json found in the project root. Browse Files to find other documentation, or skip this step.");
        else if (result === "opened") { closeNavigation(); setCollapsed(true); setNotice(""); }
      }).catch(() => { if (stillCurrent()) setNotice("Could not find run instructions. Click Find run instructions to retry, or skip this step."); });
    } else if (step === "file") {
      navigate("explorer");
    } else if (step === "search" || step === "git") navigate(step);
    else if (step === "chat" || step === "terminal") openWorkTab(step);
    else if (step === "send" && project) {
      window.dispatchEvent(new CustomEvent("ppm:onboarding-prompt", { detail: { projectName: project.name, text: ONBOARDING_SUGGESTED_PROMPT } }));
      setNotice("Review the question in chat, then send it yourself. If you already have a draft, it stays unchanged.");
      setCollapsed(true);
    } else if (step === "history") {
      const target = findTourTarget("chat-history");
      if (target) { target.click(); setCollapsed(true); }
      else setNotice("Open the chat you used, then choose its history menu. You can skip if no conversation was created.");
    }
  }
  if (paletteOpen) return null;
  // Keep every drawer row reachable, including the first file under the header.
  // Closing the drawer restores the guide; completed tours still show their summary.
  if (mobile && navigationOpen && collapsed && state.status === "active") return null;
  if (orientationOpen) return <OnboardingQuickOrientation onClose={() => setOrientationOpen(false)} onTryPalette={() => {
    setOrientationOpen(false);
    setCollapsed(true);
    requestAnimationFrame(() => openCommandPalette());
  }} />;
  if (state.status === "dismissed") return null;
  if (state.status === "choosing") return <OnboardingSetup projectName={project?.name} />;
  return <OnboardingHint collapsed={collapsed} target={state.status === "active" && state.currentStep ? ONBOARDING_TARGETS[state.currentStep] : undefined}>
    <OnboardingStepTransition stepKey={state.status === "active" ? state.currentStep ?? "project" : state.status}
      order={state.status === "finished" ? 100 : state.status === "active" ? getOnboardingSteps(state.goal).indexOf(state.currentStep!) + 1 : 0}>
    {state.status === "active" ? <>
      <OnboardingGuide collapsed={collapsed} setCollapsed={setCollapsed} onAction={action} onSettings={() => { openSettings("ai-provider"); setCollapsed(true); }} />
      {notice && !collapsed && <p role="status" className="px-4 pb-4 text-xs text-text-secondary">{notice}</p>}
    </> : <div className="p-5">
      <div className="flex items-center gap-2 text-primary text-xs uppercase tracking-widest"><Sparkles className="size-4" />Your first steps</div>
      <h2 className="font-semibold text-lg mt-2">{state.status === "finished" ? "Your walkthrough is complete" : state.status === "paused" ? "Continue when you're ready" : "Get started with PPM"}</h2>
      <p className="text-sm text-text-secondary leading-relaxed mt-2">{state.status === "finished" ? `${state.completed.length} steps completed${state.skipped.length ? ` · ${state.skipped.length} skipped` : ""}. Choose another path, or keep exploring.` : state.status === "paused" ? "Your progress is saved in this browser. Resume here or choose a different guide." : "Choose a guide that fits your experience, then try your first task."}</p>
      <Button className="w-full min-h-11 mt-4" onClick={() => { setCollapsed(false); state.status === "paused" ? state.resume(project?.name ?? null) : state.status === "finished" ? state.replay() : state.begin(); }}>{state.status === "paused" ? "Resume tour" : state.status === "finished" ? "Try another guide" : "Start guided tour"}</Button>
      <Button variant="ghost" className="w-full min-h-11 mt-1" onClick={state.dismiss}>{state.status === "finished" ? "Keep exploring" : "Maybe later"}</Button>
      <Button variant="link" className="w-full min-h-11" onClick={() => setOrientationOpen(true)}>Quick orientation</Button>
    </div>}
    </OnboardingStepTransition>
  </OnboardingHint>;
}
