import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { useSettingsStore } from "@/stores/settings-store";
import { buildXtermTheme } from "@/theme/adapters/xterm-adapter";
import { resolveTheme as resolvePpmTheme } from "@/theme/resolve-theme";
import { getCurrentAppliedTheme, THEME_CHANGE_EVENT } from "@/theme/apply-theme";
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
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Stable tab ID for persisting session across reload */
  tabId?: string;
}

interface UseTerminalReturn {
  connected: boolean;
  reconnecting: boolean;
  exited: boolean;
  sendData: (data: string) => void;
  getSelection: () => string;
  /** Read buffer from last command start to current cursor (for "Send to Chat"). */
  getLastCommandOutput: () => string;
  restart: () => void;
}

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

  const sendData = useCallback((data: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
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
    const path = `/ws/project/${encodeURIComponent(projectName)}/terminal/${sid}`;
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
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => webglAddon.dispose());
      term.loadAddon(webglAddon);
    } catch {
      // WebGL unsupported — xterm keeps the DOM renderer.
    }

    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;

    // Wire input to WS + track command boundaries
    term.onData((data) => {
      // When user presses Enter, mark next row as command output start
      if (data.includes("\r") || data.includes("\n")) {
        const buf = term.buffer.active;
        commandStartRow.current = buf.baseY + buf.cursorY + 1;
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
    const onVisibility = () => {
      if (document.visibilityState === "visible") checkConnection();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // ResizeObserver for auto-fit — skip when tab is hidden (0 dimensions)
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || entry.contentRect.width === 0 || entry.contentRect.height === 0) return;
      try {
        fitAddon.fit();
        sendResize();
      } catch {
        // Ignore fit errors during teardown
      }
    });
    resizeObserver.observe(container);

    // React to theme changes — the theme-change event fires after CSS vars are
    // applied, covering style, mode, system-OS, and imported-theme swaps.
    const onThemeChange = () => { term.options.theme = currentXtermTheme(); };
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);
    const unsubTheme = () => window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);

    return () => {
      unsubTheme();
      resizeObserver.disconnect();
      clearInterval(heartbeatInterval);
      document.removeEventListener("visibilitychange", onVisibility);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { connected, reconnecting, exited, sendData, getSelection, getLastCommandOutput, restart };
}
