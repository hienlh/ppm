import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";

interface UseTerminalOptions {
  sessionId: string;
  projectName?: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

interface UseTerminalReturn {
  connected: boolean;
  reconnecting: boolean;
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
  const actualSessionId = useRef(sessionId); // Track server-assigned session ID

  const sendResize = useCallback(() => {
    const term = termRef.current;
    const ws = wsRef.current;
    if (term && ws?.readyState === WebSocket.OPEN) {
      ws.send(`${RESIZE_PREFIX}${term.cols},${term.rows}`);
    }
  }, []);

  const connectWs = useCallback(() => {
    const term = termRef.current;
    if (!term) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const projectParam = options.projectName ?? "";
    // Use actual session ID from server on reconnect (not "new")
    const sid = actualSessionId.current;
    const url = `${protocol}//${window.location.host}/ws/terminal/${sid}${projectParam ? `?project=${encodeURIComponent(projectParam)}` : ""}`;

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
            if (msg.type === "session" || msg.type === "error") {
              if (msg.type === "session" && msg.id) {
                actualSessionId.current = msg.id; // Save for reconnect
              }
              if (msg.type === "error") {
                term.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
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
  }, [sessionId, sendResize]); // eslint-disable-line react-hooks/exhaustive-deps

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
      theme: {
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
      },
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(container);
    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;

    // Wire input to WS
    term.onData((data) => {
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

    return () => {
      resizeObserver.disconnect();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  return { connected, reconnecting };
}
