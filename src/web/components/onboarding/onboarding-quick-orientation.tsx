import { useRef, useState } from "react";
import { Bell, Cloud, FolderTree, Settings, Bug, Search } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { BUILTIN_SIDEBAR_TABS } from "@/lib/sidebar-tabs/tab-registry";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { OnboardingStepTransition } from "./onboarding-step-transition";

export const OPEN_QUICK_ORIENTATION = "ppm:open-quick-orientation";
export function openQuickOrientation(): void {
  window.dispatchEvent(new Event(OPEN_QUICK_ORIENTATION));
}

const descriptions: Record<string, string> = {
  history: "Return to earlier AI conversations and continue where you left off.",
  teams: "Find group conversations with multiple AI agents.",
  explorer: "Browse files and folders in the selected project.",
  search: "Find words across your project's files.",
  git: "Review changed files and diffs before committing your work.",
  database: "Browse connected databases and open the query editor.",
  tunnels: "Manage tunnels for accessing local services remotely.",
  "ai-resources": "Find available AI skills, commands and agents.",
};
const utilities = [
  { title: "Notifications", icon: Bell, body: "See conversations that finished or need your attention." },
  { title: "Cloud & Share", icon: Cloud, body: "Find sharing and remote-access options for this PPM instance." },
  { title: "File Explorer", icon: FolderTree, body: "Browse the host computer, beyond the selected project." },
  { title: "Settings", icon: Settings, body: "Configure AI, appearance and preferences; reopen guided tours." },
  { title: "Report Bug", icon: Bug, body: "Open the bug-report form when something does not work." },
];

/** Optional reference: it never changes tour progress or executes a palette command. */
export function OnboardingQuickOrientation({ onClose, onTryPalette }: { onClose: () => void; onTryPalette: () => void }) {
  const [page, setPage] = useState<"palette" | "rail">("palette");
  const mobile = useIsMobile();
  const opener = useRef(document.activeElement as HTMLElement | null);
  const openingPalette = useRef(false);
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-2xl p-5 sm:p-6" onCloseAutoFocus={(event) => {
      event.preventDefault();
      if (!openingPalette.current) {
        const target = opener.current?.isConnected ? opener.current : document.querySelector<HTMLElement>('aside[aria-label="PPM guided tour"] button');
        target?.focus();
      }
    }}>
      <div className="text-xs font-medium uppercase tracking-widest text-primary">Quick orientation</div>
      <DialogTitle className="text-xl">Find your way around PPM</DialogTitle>
      <DialogDescription>Two shortcuts to getting comfortable. Your guided-tour progress stays saved.</DialogDescription>
      <div className="flex gap-2" aria-label="Orientation topics">
        <Button variant={page === "palette" ? "default" : "outline"} className="min-h-11 flex-1" aria-pressed={page === "palette"} onClick={() => setPage("palette")}>Command Palette</Button>
        <Button variant={page === "rail" ? "default" : "outline"} className="min-h-11 flex-1" aria-pressed={page === "rail"} onClick={() => setPage("rail")}>{mobile ? "Navigation buttons" : "Left rail"}</Button>
      </div>
      <OnboardingStepTransition stepKey={page} order={page === "palette" ? 0 : 1}>
      {page === "palette" ? <section className="space-y-4" aria-label="Command Palette introduction">
        <div className="rounded-lg border border-border bg-surface p-4">
          <Search className="size-6 text-primary mb-3" />
          <h3 className="font-medium">One place to find actions and files</h3>
          <p className="text-sm text-text-secondary mt-2">Type what you need, such as “Settings”, “Open Terminal”, or a filename. Choose a result to open it.</p>
        </div>
        <p className="text-sm text-text-secondary">{mobile ? "No keyboard required: tap Open Command Palette below. The same palette works on your phone." : "Double-tap Shift to open it from anywhere. F1 is the default shortcut and can be changed in Settings → Keyboard Shortcuts."}</p>
        <p className="text-sm text-text-secondary">With a keyboard, use ↑ / ↓ to select a result, Enter to open it, and Escape to close. Opening the palette alone does not run a command.</p>
        <Button className="w-full min-h-11" onClick={() => { openingPalette.current = true; onTryPalette(); }}>Open Command Palette</Button>
      </section> : <section aria-label="Navigation introduction" className="space-y-4">
        <p className="text-sm text-text-secondary">{mobile ? "Tap the menu button at the bottom to open navigation. These are the same sections shown in the left rail on desktop." : "The icon strip on the left switches between project sections. Hover for labels; click a section to open it. Clicking the active section again collapses it."}</p>
        <div className="grid sm:grid-cols-2 gap-3">
          {BUILTIN_SIDEBAR_TABS.map(({ id, label, icon: Icon }) => <div key={id} className="flex gap-3 rounded-lg border border-border p-3">
            <Icon className="size-5 shrink-0 text-primary mt-0.5" /><div><h3 className="text-sm font-medium">{label}</h3><p className="text-sm text-text-secondary mt-1">{descriptions[id]}</p></div>
          </div>)}
        </div>
        <h3 className="font-medium text-sm">{mobile ? "Utilities in the navigation menu" : "Utilities at the bottom of the rail"}</h3>
        <div className="space-y-3">{utilities.filter((item) => !mobile || item.title !== "Notifications").map(({ title, icon: Icon, body }) => <div key={title} className="flex gap-3">
          <Icon className="size-4 shrink-0 text-primary mt-1" /><p className="text-sm text-text-secondary"><strong className="font-medium text-foreground">{title}</strong> — {body}</p>
        </div>)}</div>
        {mobile && <p className="text-sm text-text-secondary">Mobile uses shorter labels: History, Tunnels and AI for the matching sections above; Files, Cloud and Bug for File Explorer, Cloud &amp; Share and Report Bug. The menu badge signals conversations needing attention.</p>}
        <p className="text-xs text-text-secondary">Jira, Remote Desktop and extension buttons appear when available. Button order can be customized.</p>
      </section>}
      </OnboardingStepTransition>
      <Button variant="ghost" className="min-h-11" onClick={onClose}>Back to what I was doing</Button>
    </DialogContent>
  </Dialog>;
}
