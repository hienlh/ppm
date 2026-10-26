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

/**
 * Run a notification's deep link on this device: once an active extension lists the command
 * (activation can still be in flight on a cold boot), dispatch it locally, so the panel it
 * opens gets a tab here. A command that never shows up within {@link DEEP_LINK_WAIT_MS} is
 * dropped with a warning: only declared commands of installed extensions are ever run.
 * Resolves true when it ran.
 */
export function runExtensionDeepLink(link: ParsedExtensionDeepLink, deps: DeepLinkRunnerDeps = defaultDeps): Promise<boolean> {
  const command = link.kind === "view" ? link.view : link.command;
  const run = () => {
    if (link.kind === "view") deps.openViewTab(link.view, deps.titleOf(link.view) ?? link.view, link.projectName);
    else deps.dispatchCommand(link.command, link.args);
  };
  const listed = () => deps.commands()?.includes(command) ?? false;

  if (listed()) {
    run();
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ran: boolean) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      cancelTimer();
      if (ran) run();
      else deps.warn(`[deep-link] dropped ${command}: no active extension declares it after ${DEEP_LINK_WAIT_MS / 1000}s`);
      resolve(ran);
    };
    const unsubscribe = deps.subscribe(() => { if (listed()) finish(true); });
    const cancelTimer = deps.setTimer(() => finish(false), DEEP_LINK_WAIT_MS);
  });
}
