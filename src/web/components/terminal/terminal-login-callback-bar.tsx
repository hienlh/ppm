/**
 * The desktop way to finish a CLI login whose browser redirect could not reach
 * the CLI — the phone has the same field in its links sheet.
 *
 * `aws sso login`, `gcloud auth login` and the like print a sign-in link whose
 * `redirect_uri` is 127.0.0.1:<port> on the machine running PPM. When PPM is
 * reached from another computer, the browser that signs in is redirected to
 * *that* computer's loopback address, the page fails to load, and the command
 * waits forever. This bar takes the address that failed and has the server
 * deliver it (`TerminalFinishLogin`).
 *
 * It opens two ways: from the status bar's "Login callback" button at any time,
 * and by itself when the terminal prints such a link — unless the page is open
 * on the PPM machine itself, where the redirect simply works.
 */
import { useEffect, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { X } from "@/lib/icons";
import { isLoopbackHostname, loopbackRedirectPorts } from "@/lib/oauth-loopback-url";
import { TerminalFinishLogin } from "./terminal-finish-login";

/** Output arrives in bursts; scanning the scrollback once it settles is enough. */
const SCAN_DEBOUNCE_MS = 400;

/** The login ports a just-printed sign-in link redirects to, updated as the terminal writes. */
export function useLoopbackLoginPorts(terminal: Terminal | null, getBufferUrls: () => string[]): string[] {
  const [ports, setPorts] = useState<string[]>([]);
  useEffect(() => {
    if (!terminal) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scan = () => {
      const next = loopbackRedirectPorts(getBufferUrls());
      setPorts((prev) => (prev.join(",") === next.join(",") ? prev : next));
    };
    const sub = terminal.onWriteParsed(() => {
      clearTimeout(timer);
      timer = setTimeout(scan, SCAN_DEBOUNCE_MS);
    });
    scan();
    return () => {
      clearTimeout(timer);
      sub.dispose();
    };
  }, [terminal, getBufferUrls]);
  return ports;
}

/**
 * Whether to offer the field unasked: a sign-in link is waiting on a loopback
 * port, the user has not closed the offer for those ports, and this page is not
 * open on the PPM machine itself (where the redirect reaches the CLI directly).
 */
export function shouldSuggestFinishLogin(ports: readonly string[], dismissedKey: string | null, pageHostname: string): boolean {
  if (ports.length === 0) return false;
  if (isLoopbackHostname(pageHostname)) return false;
  return ports.join(",") !== dismissedKey;
}

interface TerminalLoginCallbackBarProps {
  terminal: Terminal | null;
  getBufferUrls: () => string[];
  /** Opened from the status bar, whatever the terminal printed. */
  requested: boolean;
  onRequestedChange: (open: boolean) => void;
  /** Where this page is open; the PPM machine itself needs no help. */
  pageHostname?: string;
}

export function TerminalLoginCallbackBar({
  terminal,
  getBufferUrls,
  requested,
  onRequestedChange,
  pageHostname = window.location.hostname,
}: TerminalLoginCallbackBarProps) {
  const ports = useLoopbackLoginPorts(terminal, getBufferUrls);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const suggested = shouldSuggestFinishLogin(ports, dismissedKey, pageHostname);
  if (!requested && !suggested) return null;

  const close = () => {
    setDismissedKey(ports.join(","));
    onRequestedChange(false);
  };

  return (
    // Positioned so it paints over the terminal's canvas: until xterm refits to the
    // shorter box, the canvas still has its old height and would cover the bar's top.
    <div role="region" aria-label="Finish a login" className="relative z-10 shrink-0 border-t border-border bg-surface">
      <div className="flex items-start gap-2 px-3 pt-2">
        <p className="flex-1 text-xs font-medium text-foreground">
          {ports.length > 0
            ? `This sign-in sends the browser back to port ${ports.join(", ")} on the machine running PPM`
            : "Finish a login started in this terminal"}
        </p>
        <button
          onClick={close}
          aria-label="Close"
          title="Close"
          className="flex size-6 shrink-0 items-center justify-center rounded text-text-secondary hover:bg-surface-elevated hover:text-foreground transition-colors"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <TerminalFinishLogin compact autoFocus={requested} onDone={close} />
    </div>
  );
}
