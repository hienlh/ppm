import { usePanelStore } from "@/stores/panel-store";

/**
 * Deliver a shell command to a terminal.
 *
 * Two delivery paths, because a shell that is still booting cannot accept input:
 *  1. A terminal already on screen answers the event synchronously and types the
 *     command right away — its shell is long past the prompt.
 *  2. Nobody answers ⇒ open a terminal in the dock and hand the command over via
 *     `metadata.pendingCommand`. The tab holds it until its shell has printed a
 *     prompt (see `use-terminal-command-queue`), so the text is never swallowed
 *     by shell startup.
 */
export const RUN_IN_TERMINAL_EVENT = "ppm:run-in-terminal";
export const RUN_IN_TERMINAL_ACK_EVENT = "ppm:run-in-terminal:ack";

export interface RunInTerminalDetail {
  command: string;
  projectName?: string | null;
}

/**
 * Normalize a copied code block into terminal input: drop `$ ` prompt markers and
 * the trailing newline, so the last line waits on the user's Enter instead of
 * running itself.
 */
export function normalizeTerminalCommand(text: string): string {
  // A space after the `$` is required: `$HOME/bin/tool` starting a line is part of
  // the command, not a prompt.
  return text.replace(/^[ \t]*\$[ \t]+/gm, "").replace(/\s+$/, "");
}

export function runInTerminal(rawCommand: string, projectName?: string | null): void {
  const command = normalizeTerminalCommand(rawCommand);
  if (!command) return;

  // Offer it to a live terminal first (dispatch is synchronous, so the ack lands
  // before this returns).
  let handled = false;
  const onAck = () => { handled = true; };
  window.addEventListener(RUN_IN_TERMINAL_ACK_EVENT, onAck);
  window.dispatchEvent(
    new CustomEvent<RunInTerminalDetail>(RUN_IN_TERMINAL_EVENT, { detail: { command, projectName } }),
  );
  window.removeEventListener(RUN_IN_TERMINAL_ACK_EVENT, onAck);
  if (handled) return;

  usePanelStore.getState().openInDock({
    type: "terminal",
    title: "Terminal",
    projectId: projectName ?? null,
    closable: true,
    metadata: { ...(projectName ? { projectName } : {}), pendingCommand: command },
  });
}
