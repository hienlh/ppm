import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { withWsAuth } from "@/lib/ws-auth";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { useSettingsStore } from "@/stores/settings-store";
import { buildXtermTheme } from "@/theme/adapters/xterm-adapter";
import { resolveTheme as resolvePpmTheme } from "@/theme/resolve-theme";
import { getCurrentAppliedTheme, THEME_CHANGE_EVENT } from "@/theme/apply-theme";
import { onHostResize } from "@/components/floating-window/pip/pip-resize-signal";
import type { PpmTheme } from "@/theme/types";

/** Current active PpmTheme → xterm ITheme (prefers the live applied theme). */
function currentXtermTheme(): ITheme {
  const s = useSettingsStore.getState();
  const theme: PpmTheme =
    getCurrentAppliedTheme() ??
    resolvePpmTheme(s.themeStyle, s.themeMode, s.customThemes, s.customThemeId);
  return buildXtermTheme(theme);
}

interface UseTerminalOptions {
  sessionId: string;
  projectName?: string;
  /** Absolute start directory for a brand-new shell; ignored when re-attaching to a session. */
  cwd?: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Stable tab ID for persisting session across reload */
  tabId?: string;
}

interface UseTerminalReturn {
  connected: boolean;
  reconnecting: boolean;
  exited: boolean;
  /** True once the shell has printed its prompt and stopped writing — safe to inject input. */
  shellReady: boolean;
  sendData: (data: string) => void;
  getSelection: () => string;
  /** Read buffer from last command start to current cursor (for "Send to Chat"). */
  getLastCommandOutput: () => string;
  /** The prompt line the last command was typed on, empty until one is entered. */
  getLastCommand: () => string;
  /** URLs present in the scrollback, most recent first. */
  getBufferUrls: () => string[];
  restart: () => void;
}

/** Trailing punctuation that ends a sentence rather than the URL itself. */
const URL_TRAILING_PUNCT = /[).,;:'"\]}>]+$/;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/g;
/** Cap the scan so a 50k-line scrollback never blocks the tap that triggered it. */
const URL_SCAN_MAX_ROWS = 5000;
/** Quiet period before refitting to a new container size, in ms. */
const RESIZE_SETTLE_MS = 100;

/** Quiet period after the last PTY output that means the prompt is printed and the shell is idle. */
const SHELL_READY_QUIET_MS = 250;
/** Upper bound on waiting for that prompt — a shell that prints nothing must not block input forever. */
const SHELL_READY_MAX_MS = 3000;

const RESIZE_PREFIX = "\x01RESIZE:";
const PING_MSG = "\x01PING";
const PONG_MSG = "\x01PONG";
/** Send keepalive ping well below the server's 16-min WS idleTimeout */
const HEARTBEAT_INTERVAL_MS = 15_000;
/** No PONG/output for this long ⇒ socket is a zombie ⇒ force reconnect.
 *  After suspend/sleep the browser keeps reporting readyState OPEN even though
 *  the connection is dead, so input is silently dropped — this detects it. */
const HEARTBEAT_TIMEOUT_MS = 35_000;

export function useTerminal(
  options: UseTerminalOptions,
): UseTerminalReturn {
  const { sessionId, containerRef } = options;
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const hasConnectedBefore = useRef(false);
  /** Timestamp of last inbound WS message (output or PONG) — drives zombie detection */
  const lastActivityRef = useRef(Date.now());
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [exited, setExited] = useState(false);
  /** A brand-new shell needs to finish booting before it accepts injected input. */
  const [shellReady, setShellReady] = useState(false);
  const readyQuietTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readyMaxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Restore persisted session ID from localStorage (survives page reload)
  const storageKey = options.tabId ? `ppm:terminal-session:${options.tabId}` : null;
  const initialSessionId = (() => {
    if (storageKey) {
      try { return localStorage.getItem(storageKey) ?? sessionId; } catch { /* */ }
    }
    return sessionId;
  })();
  const actualSessionId = useRef(initialSessionId);
  /** Absolute row where last command output starts (set when user presses Enter) */
  const commandStartRow = useRef(0);
  /** Absolute row of the prompt line that command was typed on, -1 before any Enter.
   *  Output alone reads as an orphan in chat — the command is what gives it meaning. */
  const commandRow = useRef(-1);

  const sendData = useCallback((data: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }, []);

  /** Debounce PTY output: the shell counts as booted once it goes quiet. */
  const noteOutput = useCallback(() => {
    if (readyQuietTimer.current) clearTimeout(readyQuietTimer.current);
    readyQuietTimer.current = setTimeout(() => setShellReady(true), SHELL_READY_QUIET_MS);
  }, []);

  const getSelection = useCallback(() => {
    return termRef.current?.getSelection() ?? "";
  }, []);

  const getLastCommandOutput = useCallback(() => {
    const term = termRef.current;
    if (!term) return "";
    const buf = term.buffer.active;
    const startRow = commandStartRow.current;
    const endRow = buf.baseY + buf.cursorY;
    const lines: string[] = [];
    for (let i = startRow; i <= endRow; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    return lines.join("\n");
  }, []);

  const getLastCommand = useCallback(() => {
    const term = termRef.current;
    if (!term || commandRow.current < 0) return "";
    return term.buffer.active.getLine(commandRow.current)?.translateToString(true).trimEnd() ?? "";
  }, []);

  /**
   * Collect URLs from the scrollback.
   *
   * xterm's link addon activates a link from a mouse hover followed by mouseup,
   * neither of which a touch device produces, so on mobile this list is the only
   * way to reach a URL the shell printed (an `aws sso login` code, for example).
   * Wrapped lines are joined first — a URL long enough to matter is usually the
   * one that got split across rows.
   */
  const getBufferUrls = useCallback(() => {
    const term = termRef.current;
    if (!term) return [];
    const buf = term.buffer.active;
    const endRow = buf.baseY + buf.cursorY;
    const startRow = Math.max(0, endRow - URL_SCAN_MAX_ROWS);

    const logical: string[] = [];
    let current = "";
    for (let i = startRow; i <= endRow; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      current += line.translateToString(true);
      // isWrapped marks a row as the continuation of the previous one, so the
      // break is a display artefact and must not split the URL.
      const next = buf.getLine(i + 1);
      if (next?.isWrapped) continue;
      logical.push(current);
      current = "";
    }
    if (current) logical.push(current);

    const seen = new Set<string>();
    const urls: string[] = [];
    for (const text of logical) {
      for (const match of text.match(URL_PATTERN) ?? []) {
        const url = match.replace(URL_TRAILING_PUNCT, "");
        if (!url || seen.has(url)) continue;
        seen.add(url);
        urls.push(url);
      }
    }
    return urls.reverse();
  }, []);

  const sendResize = useCallback(() => {
    const term = termRef.current;
    const ws = wsRef.current;
    if (term && ws?.readyState === WebSocket.OPEN) {
      ws.send(`${RESIZE_PREFIX}${term.cols},${term.rows}`);
    }
  }, []);

  const restart = useCallback(() => {
    // Close existing WS, reset to "new" session, reconnect
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    wsRef.current?.close();
    wsRef.current = null;
    actualSessionId.current = "new";
    if (storageKey) { try { localStorage.removeItem(storageKey); } catch { /* */ } }
    reconnectAttempts.current = 0;
    setExited(false);
    setShellReady(false);
    setConnected(false);
    setReconnecting(false);
    // connectWs will be called after this via setTimeout to allow state to settle
    setTimeout(() => connectWs(), 0);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const connectWs = useCallback(() => {
    // Prevent duplicate connections (e.g. React StrictMode re-mount racing
    // with a scheduled reconnect from the previous mount's WS close event).
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    if (wsRef.current) {
      wsRef.current.onclose = null; // prevent triggering scheduleReconnect
      wsRef.current.close();
      wsRef.current = null;
    }

    const term = termRef.current;
    if (!term) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const projectName = options.projectName ?? "";
    // Use actual session ID from server on reconnect (not "new")
    const sid = actualSessionId.current;
    const cwdQuery = sid === "new" && options.cwd ? `?cwd=${encodeURIComponent(options.cwd)}` : "";
    const path = withWsAuth(`/ws/project/${encodeURIComponent(projectName)}/terminal/${sid}${cwdQuery}`);
    // Local dev over http: connect directly to backend (port 8081) to bypass
    // Vite's dev proxy which has unreliable WebSocket upgrade handling. Over https
    // (e.g. a Cloudflare tunnel) port 8081 isn't reachable and ws:// is blocked as
    // mixed content, so use the same-origin wss:// proxy instead.
    const url = import.meta.env.DEV && window.location.protocol !== "https:"
      ? `ws://${window.location.hostname}:8081${path}`
      : `${protocol}//${window.location.host}${path}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      // On reconnect, clear terminal before backend replays buffer to avoid duplicates
      if (hasConnectedBefore.current && termRef.current) {
        termRef.current.clear();
      }
      hasConnectedBefore.current = true;
      lastActivityRef.current = Date.now();
      setConnected(true);
      setReconnecting(false);
      reconnectAttempts.current = 0;
      // A re-attach lands on a shell that booted long ago; only a fresh session
      // has to wait for a prompt.
      if (actualSessionId.current === "new") setShellReady(false);
      if (readyMaxTimer.current) clearTimeout(readyMaxTimer.current);
      readyMaxTimer.current = setTimeout(() => setShellReady(true), SHELL_READY_MAX_MS);
      sendResize();
    };

    ws.onmessage = (event) => {
      lastActivityRef.current = Date.now();
      if (typeof event.data === "string") {
        // Keepalive pong — confirms the socket is alive; not terminal output
        if (event.data === PONG_MSG) return;
        // Filter JSON control messages from terminal output
        if (event.data.startsWith("{")) {
          try {
            const msg = JSON.parse(event.data);
            // Any valid JSON with a "type" field is a control/system message —
            // real PTY output is raw text/escape sequences, never typed JSON.
            // Handle known terminal control types, silently drop everything else
            // (e.g. chat events that may leak via WS under race conditions).
            if (msg.type) {
              if (msg.type === "session" && msg.id) {
                actualSessionId.current = msg.id;
                if (storageKey) {
                  try { localStorage.setItem(storageKey, msg.id); } catch { /* */ }
                }
              }
              if (msg.type === "error") {
                term.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
              }
              if (msg.type === "exited") {
                setExited(true);
              }
              return; // Never write typed JSON to terminal
            }
          } catch {
            // Not JSON, write as terminal output
          }
        }
        noteOutput();
        term.write(event.data);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [sendResize]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Keepalive + zombie detection. Runs on an interval and on tab-visible.
   *  Trusting readyState alone is unsafe: a suspended/slept connection reports
   *  OPEN while being dead, so we probe with PING and reconnect when silent. */
  const checkConnection = useCallback(() => {
    if (document.visibilityState !== "visible") return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWs(); // not open — reconnect now (skips backoff wait)
      return;
    }
    if (Date.now() - lastActivityRef.current > HEARTBEAT_TIMEOUT_MS) {
      connectWs(); // no PONG/output for too long — zombie socket, force reconnect
      return;
    }
    try { ws.send(PING_MSG); } catch { connectWs(); }
  }, [connectWs]);

  function scheduleReconnect() {
    const delay = Math.min(
      1000 * Math.pow(2, reconnectAttempts.current),
      30000,
    );
    reconnectAttempts.current++;
    setReconnecting(true);
    reconnectTimer.current = setTimeout(() => {
      connectWs();
    }, delay);
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      scrollback: 50000,
      // Explicit terminal-grade stack: the WebGL renderer builds its glyph
      // atlas via ctx.font and cannot resolve CSS var() values.
      fontFamily: "Consolas, 'Cascadia Mono', Menlo, 'DejaVu Sans Mono', 'Courier New', monospace",
      theme: currentXtermTheme(),
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(container);

    // WebGL renderer draws block/box-drawing glyphs geometrically (gap-free),
    // so QR codes render seamlessly like a native terminal. The DOM renderer
    // leaves sub-pixel gaps between rows. Fall back to DOM if WebGL is
    // unavailable or its context is lost.
    // Skip WebGL on touch devices: iOS Safari throttles the WebGL context in a
    // small canvas, producing visible per-keystroke input lag. The DOM renderer
    // types smoothly there; QR seamlessness is a desktop-only nicety.
    const isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
    if (!isTouch) {
      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => webglAddon.dispose());
        term.loadAddon(webglAddon);
      } catch {
        // WebGL unsupported — xterm keeps the DOM renderer.
      }
    }

    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;

    // Wire input to WS + track command boundaries
    term.onData((data) => {
      // When user presses Enter, mark next row as command output start
      if (data.includes("\r") || data.includes("\n")) {
        const buf = term.buffer.active;
        commandRow.current = buf.baseY + buf.cursorY;
        commandStartRow.current = commandRow.current + 1;
      }
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // Connect WS
    connectWs();

    // Keepalive heartbeat + zombie detection (covers suspend/sleep/network drop)
    const heartbeatInterval = setInterval(checkConnection, HEARTBEAT_INTERVAL_MS);
    // Bound to the container's own document: the terminal may be living in a
    // picture-in-picture window, whose visibility is not the main document's.
    const hostDoc = container.ownerDocument;
    const onVisibility = () => {
      if (hostDoc.visibilityState === "visible") checkConnection();
    };
    hostDoc.addEventListener("visibilitychange", onVisibility);

    // ResizeObserver for auto-fit — skip when tab is hidden (0 dimensions).
    // Debounced: an on-screen keyboard resizes the container many times as it
    // slides, and refitting on each one sends the shell a burst of size changes
    // that it answers by redrawing, so the output visibly churns. One fit once
    // the size settles gives the same result without the churn.
    let fitTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || entry.contentRect.width === 0 || entry.contentRect.height === 0) return;
      if (fitTimer) clearTimeout(fitTimer);
      fitTimer = setTimeout(() => {
        try {
          fitAddon.fit();
          sendResize();
        } catch {
          // Ignore fit errors during teardown
        }
      }, RESIZE_SETTLE_MS);
    });
    resizeObserver.observe(container);

    // Host-driven resize (picture-in-picture): the ResizeObserver above only
    // reports a PiP-driven size seconds later, so refit as soon as the host says
    // its size changed.
    const unsubHostResize = onHostResize(container, () => {
      try {
        fitAddon.fit();
        sendResize();
      } catch {
        // Ignore fit errors while the tab is detached or tearing down
      }
    });

    // React to theme changes — the theme-change event fires after CSS vars are
    // applied, covering style, mode, system-OS, and imported-theme swaps.
    const onThemeChange = () => { term.options.theme = currentXtermTheme(); };
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);
    const unsubTheme = () => window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);

    return () => {
      unsubTheme();
      unsubHostResize();
      if (fitTimer) clearTimeout(fitTimer);
      resizeObserver.disconnect();
      clearInterval(heartbeatInterval);
      hostDoc.removeEventListener("visibilitychange", onVisibility);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (readyQuietTimer.current) clearTimeout(readyQuietTimer.current);
      if (readyMaxTimer.current) clearTimeout(readyMaxTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { connected, reconnecting, exited, shellReady, sendData, getSelection, getLastCommandOutput, getLastCommand, getBufferUrls, restart };
}
