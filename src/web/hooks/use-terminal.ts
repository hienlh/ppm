import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { useSettingsStore, type Theme } from "@/stores/settings-store";

const DARK_THEME: ITheme = {
  background: "#0f1419",
  foreground: "#e5e7eb",
  cursor: "#e5e7eb",
  selectionBackground: "#3b82f640",
  black: "#1a1f2e",
  red: "#ef4444",
  green: "#10b981",
  yellow: "#f59e0b",
  blue: "#3b82f6",
  magenta: "#a855f7",
  cyan: "#06b6d4",
  white: "#e5e7eb",
  brightBlack: "#6b7280",
  brightRed: "#f87171",
  brightGreen: "#34d399",
  brightYellow: "#fbbf24",
  brightBlue: "#60a5fa",
  brightMagenta: "#c084fc",
  brightCyan: "#22d3ee",
  brightWhite: "#f9fafb",
};

const LIGHT_THEME: ITheme = {
  background: "#ffffff",
  foreground: "#1a1f2e",
  cursor: "#1a1f2e",
  selectionBackground: "#2563eb30",
  black: "#1a1f2e",
  red: "#dc2626",
  green: "#059669",
  yellow: "#d97706",
  blue: "#2563eb",
  magenta: "#9333ea",
  cyan: "#0891b2",
  white: "#f8fafc",
  brightBlack: "#64748b",
  brightRed: "#ef4444",
  brightGreen: "#10b981",
  brightYellow: "#f59e0b",
  brightBlue: "#3b82f6",
  brightMagenta: "#a855f7",
  brightCyan: "#06b6d4",
  brightWhite: "#ffffff",
};

function resolveTheme(theme: Theme): ITheme {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? DARK_THEME : LIGHT_THEME;
  }
  return theme === "light" ? LIGHT_THEME : DARK_THEME;
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

export function useTerminal(
  options: UseTerminalOptions,
): UseTerminalReturn {
  const { sessionId, containerRef } = options;
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
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
    // In dev mode, connect directly to backend (port 8081) to bypass
    // Vite's dev proxy which has unreliable WebSocket upgrade handling.
    const url = import.meta.env.DEV
      ? `ws://${window.location.hostname}:8081${path}`
      : `${protocol}//${window.location.host}${path}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setReconnecting(false);
      reconnectAttempts.current = 0;
      sendResize();
    };

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        // Filter JSON control messages from terminal output
        if (event.data.startsWith("{")) {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "session" || msg.type === "error" || msg.type === "exited" || msg.type === "ping") {
              if (msg.type === "session" && msg.id) {
                actualSessionId.current = msg.id;
                // Persist to localStorage so reload reconnects to same PTY
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
              return; // Don't write raw JSON to terminal
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
      fontFamily: "var(--font-mono)",
      theme: resolveTheme(useSettingsStore.getState().theme),
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(container);
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

    // ResizeObserver for auto-fit
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
        sendResize();
      } catch {
        // Ignore fit errors during teardown
      }
    });
    resizeObserver.observe(container);

    // React to theme changes
    let prevTheme = useSettingsStore.getState().theme;
    const unsubTheme = useSettingsStore.subscribe((state) => {
      if (state.theme !== prevTheme) {
        prevTheme = state.theme;
        term.options.theme = resolveTheme(state.theme);
      }
    });

    return () => {
      unsubTheme();
      resizeObserver.disconnect();
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
