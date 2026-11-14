/**
 * Bringing one folder or file of a project into view in that project's file tree (the sidebar's
 * Explorer; the navigation drawer on a phone) from somewhere else — the PPM Assistant's
 * `ui_reveal_path`. Not the OS File Explorer window, which `open-explorer` opens.
 *
 * The tree may not be mounted at all (another sidebar section showing, a phone with its drawer
 * shut), and when it mounts for a project it resets its store and restores that project's own
 * expanded folders. So what to reveal is kept here, and the tree applies it once it shows that
 * project with its root loaded, rather than being sent an event it would miss or have wiped.
 */
import { create } from "zustand";
import { useSettingsStore } from "@/stores/settings-store";
import { isMobileDevice } from "@/hooks/use-is-mobile";
import { OPEN_NAVIGATION } from "@/components/database/db-sidebar-reveal";

export interface ExplorerReveal {
  /** Distinguishes two reveals of the same path, so a caller waits for its own. */
  id: number;
  projectName: string;
  /** Relative to the project, `/`-separated; `""` is the project's folder. */
  path: string;
  kind: "file" | "folder";
}

export type RevealOutcome = { id: number; ok: true } | { id: number; ok: false; error: string };

interface RevealState {
  pending: ExplorerReveal | null;
  /** How the latest reveal ended, read by whoever asked for it. */
  outcome: RevealOutcome | null;
  finish: (outcome: RevealOutcome) => void;
}

let nextId = 1;

export const useExplorerReveal = create<RevealState>((set, get) => ({
  pending: null,
  outcome: null,
  finish: (outcome) => set({ outcome, pending: get().pending?.id === outcome.id ? null : get().pending }),
}));

/** Puts the Explorer on screen: the sidebar section on a desktop, the drawer on a phone. */
export function showExplorer(): void {
  const settings = useSettingsStore.getState();
  if (settings.sidebarActiveTab !== "explorer") settings.setSidebarActiveTab("explorer");
  if (isMobileDevice()) window.dispatchEvent(new CustomEvent(OPEN_NAVIGATION, { detail: { tab: "explorer" } }));
  else if (settings.sidebarCollapsed) settings.toggleSidebar();
}

/** Asks the tree to reveal `path` and shows the Explorer; resolves with how it ended, or a timeout. */
export function revealInExplorer(target: Omit<ExplorerReveal, "id">, timeoutMs = 6_000): Promise<RevealOutcome> {
  const id = nextId++;
  // A reveal still waiting is replaced, and its caller told so now rather than after its timeout.
  const replaced = useExplorerReveal.getState().pending;
  if (replaced) useExplorerReveal.getState().finish({ id: replaced.id, ok: false, error: "A newer reveal replaced this one before the Explorer showed it." });
  useExplorerReveal.setState({ pending: { ...target, id }, outcome: null });
  showExplorer();
  return new Promise((done) => {
    const stop = (outcome: RevealOutcome) => { clearTimeout(timer); unsubscribe(); done(outcome); };
    const unsubscribe = useExplorerReveal.subscribe((s) => { if (s.outcome?.id === id) stop(s.outcome); });
    const timer = setTimeout(() => {
      if (useExplorerReveal.getState().pending?.id === id) useExplorerReveal.setState({ pending: null });
      stop({ id, ok: false, error: "The Explorer did not show the path in time; it may be hidden on this device." });
    }, timeoutMs);
  });
}
