import { useExtensionStore } from "@/stores/extension-store";
import { useTabStore } from "@/stores/tab-store";
import {
  DEEP_LINK_PARAMS, parseExtensionDeepLink, stripExtensionDeepLink, type ParsedExtensionDeepLink,
} from "../../shared/extension-deep-link";

/**
 * The deep link the page was opened with, removed from the address bar at once so a reload or
 * a shared URL does not run it again. Malformed parameters are removed too, and give null.
 */
export function takeDeepLinkFromLocation(): ParsedExtensionDeepLink | null {
  const href = window.location.href;
  const current = new URL(href);
  if (!DEEP_LINK_PARAMS.some((name) => current.searchParams.has(name))) return null;
  const link = parseExtensionDeepLink(href);
  const stripped = stripExtensionDeepLink(current);
  window.history.replaceState(window.history.state, "", `${stripped.pathname}${stripped.search}${stripped.hash}`);
  return link;
}

/** How long a link waits for the extension that owns its command to be activated. */
export const DEEP_LINK_WAIT_MS = 20_000;

export interface DeepLinkRunnerDeps {
  /** The command ids active extensions contribute, or null before the first contributions arrive. */
  commands(): string[] | null;
  /** The commands active extensions let a link run (`contributes.deepLinkCommands`). */
  deepLinkCommands(): string[];
  /** Called on every contributions change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  dispatchCommand(command: string, args: unknown[]): void;
  openViewTab(view: string, title: string, projectName?: string): void;
  titleOf(command: string): string | undefined;
  warn(message: string): void;
  setTimer(fn: () => void, ms: number): () => void;
}

const defaultDeps: DeepLinkRunnerDeps = {
  commands: () => useExtensionStore.getState().contributions?.commands?.map((c) => c.command) ?? null,
  deepLinkCommands: () => useExtensionStore.getState().contributions?.deepLinkCommands ?? [],
  subscribe: (listener) => useExtensionStore.subscribe(listener),
  dispatchCommand: (command, args) =>
    window.dispatchEvent(new CustomEvent("ext:command:execute", { detail: { command, args } })),
  // A tab with no panel yet: the webview host sees it and dispatches the view's command itself,
  // which is the one way a panel opened from outside a click still gets a tab on this device.
  openViewTab: (view, title, projectName) =>
    useTabStore.getState().openTab({
      type: "extension",
      title,
      projectId: null,
      closable: true,
      metadata: { viewType: view.replace(/\.view$/, ""), ...(projectName && { projectName }) },
    }),
  titleOf: (command) => useExtensionStore.getState().contributions?.commands?.find((c) => c.command === command)?.title,
  warn: (message) => console.warn(message),
  setTimer: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};

type Verdict = "run" | "refuse" | "wait";

/**
 * Whether a link may run now. A view opens once an active extension declares it. A command runs
 * only when its extension listed it in `contributes.deepLinkCommands`: a URL can be hand-made,
 * so the browser never trusts that the server built it. A command that is declared but not
 * linkable is refused at once; one nothing declares yet may belong to an extension still
 * activating, so it waits.
 */
function verdict(link: ParsedExtensionDeepLink, deps: DeepLinkRunnerDeps): Verdict {
  const declared = deps.commands();
  if (link.kind === "view") return declared?.includes(link.view) ? "run" : "wait";
  if (deps.deepLinkCommands().includes(link.command)) return "run";
  return declared?.includes(link.command) ? "refuse" : "wait";
}

/**
 * Run a notification's deep link on this device, locally, so a panel it opens gets a tab here.
 * Activation can still be in flight on a cold boot, so an unknown target waits up to
 * {@link DEEP_LINK_WAIT_MS} and is then dropped with a warning. Resolves true when it ran.
 */
export function runExtensionDeepLink(link: ParsedExtensionDeepLink, deps: DeepLinkRunnerDeps = defaultDeps): Promise<boolean> {
  const target = link.kind === "view" ? link.view : link.command;
  const run = () => {
    if (link.kind === "view") deps.openViewTab(link.view, deps.titleOf(link.view) ?? link.view, link.projectName);
    else deps.dispatchCommand(link.command, link.args);
  };
  const refuse = () => deps.warn(`[deep-link] refused ${target}: its extension does not list it in contributes.deepLinkCommands`);

  const first = verdict(link, deps);
  if (first === "run") { run(); return Promise.resolve(true); }
  if (first === "refuse") { refuse(); return Promise.resolve(false); }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: "run" | "refuse" | "timeout") => {
      if (settled) return;
      settled = true;
      unsubscribe();
      cancelTimer();
      if (outcome === "run") run();
      else if (outcome === "refuse") refuse();
      else deps.warn(`[deep-link] dropped ${target}: no active extension declares it after ${DEEP_LINK_WAIT_MS / 1000}s`);
      resolve(outcome === "run");
    };
    const unsubscribe = deps.subscribe(() => {
      const now = verdict(link, deps);
      if (now !== "wait") finish(now);
    });
    const cancelTimer = deps.setTimer(() => finish("timeout"), DEEP_LINK_WAIT_MS);
  });
}
