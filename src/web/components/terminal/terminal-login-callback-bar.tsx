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
 * on a loopback hostname, where the redirect reaches the CLI directly. (A
 * browser reaching PPM through an SSH `-L` forward also sees `localhost` and
 * gets no offer; the button still works there.) Closing the offer holds for
 * the ports it named, for as long as the tab stays mounted.
 */
import { useCallback, useEffect, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { X } from "@/lib/icons";
import { isLoopbackHostname, loopbackRedirectPorts } from "@/lib/oauth-loopback-url";
import { TerminalFinishLogin } from "./terminal-finish-login";

/** How often, at most, the scrollback is scanned while output keeps arriving. */
const SCAN_INTERVAL_MS = 1000;
/**
 * How far back a scan looks. A sign-in link is printed just before the CLI
 * starts waiting, so it sits near the bottom; scanning the whole scrollback
 * after every write would cost far more and find nothing new.
 */
const SCAN_ROWS = 300;

/**
 * The login ports the sign-in links near the bottom of the terminal redirect
 * to. Scanned once on mount and then at most once a second while the terminal
 * writes — a throttle rather than a debounce, so output that never pauses
 * (`tail -f`, a long build) cannot keep a printed link from being noticed.
 */
export function useLoopbackLoginPorts(
  terminal: Terminal | null,
  getBufferUrls: (maxRows?: number) => string[],
  enabled = true,
): string[] {
  const [ports, setPorts] = useState<string[]>([]);
  useEffect(() => {
    if (!terminal || !enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scan = () => {
      timer = undefined;
      const next = loopbackRedirectPorts(getBufferUrls(SCAN_ROWS));
      setPorts((prev) => (prev.join(",") === next.join(",") ? prev : next));
    };
    const sub = terminal.onWriteParsed(() => {
      timer ??= setTimeout(scan, SCAN_INTERVAL_MS);
    });
    scan();
    return () => {
      clearTimeout(timer);
      sub.dispose();
    };
  }, [terminal, getBufferUrls, enabled]);
  return ports;
}

/**
 * Whether to offer the field unasked: a sign-in link is waiting on a loopback
 * port, the user has not closed the offer for those ports, and this page is not
 * open on a loopback hostname (where the redirect reaches the CLI directly).
 */
export function shouldSuggestFinishLogin(ports: readonly string[], dismissedKey: string | null, pageHostname: string): boolean {
  if (ports.length === 0) return false;
  if (isLoopbackHostname(pageHostname)) return false;
  return ports.join(",") !== dismissedKey;
}

export interface LoginCallbackBarState {
  visible: boolean;
  /** Opened from the status bar rather than offered by itself. */
  requested: boolean;
  ports: string[];
  /** The status-bar button: closes the bar when it shows, for whichever reason it shows. */
  toggle: () => void;
  close: () => void;
}

/** Everything the terminal tab needs to drive the bar and its status-bar button. */
export function useLoginCallbackBar(
  terminal: Terminal | null,
  getBufferUrls: (maxRows?: number) => string[],
  { enabled = true, pageHostname = window.location.hostname }: { enabled?: boolean; pageHostname?: string } = {},
): LoginCallbackBarState {
  const ports = useLoopbackLoginPorts(terminal, getBufferUrls, enabled);
  const [requested, setRequested] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const suggested = enabled && shouldSuggestFinishLogin(ports, dismissedKey, pageHostname);
  const visible = enabled && (requested || suggested);
  const portsKey = ports.join(",");

  const close = useCallback(() => {
    setDismissedKey(portsKey);
    setRequested(false);
  }, [portsKey]);
  const toggle = useCallback(() => {
    if (visible) close();
    else setRequested(true);
  }, [visible, close]);

  return { visible, requested, ports, toggle, close };
}

export function TerminalLoginCallbackBar({ bar }: { bar: LoginCallbackBarState }) {
  if (!bar.visible) return null;
  return (
    // Positioned so it paints over the terminal's canvas: until xterm refits to the
    // shorter box, the canvas still has its old height and would cover the bar's top.
    <div role="region" aria-label="Finish a login" className="relative z-10 shrink-0 border-t border-border bg-surface">
      <div className="flex items-start gap-2 px-3 pt-2">
        <p className="flex-1 text-xs font-medium text-foreground">
          {bar.ports.length > 0
            ? `This sign-in sends the browser back to port ${bar.ports.join(", ")} on the machine running PPM`
            : "Finish a login started in this terminal"}
        </p>
        <button
          onClick={bar.close}
          aria-label="Close"
          title="Close"
          className="flex size-6 shrink-0 items-center justify-center rounded text-text-secondary hover:bg-surface-elevated hover:text-foreground transition-colors"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <TerminalFinishLogin compact autoFocus={bar.requested} onDone={bar.close} />
    </div>
  );
}
