import { useEffect, useRef } from "react";
import { toast } from "sonner";

const RECONNECT_INTERVAL = 5_000;
const PING_INTERVAL = 5_000;
const PONG_TIMEOUT = 3_000;
const LOGS_URL = "/api/logs/recent";
const REPO = "hienlh/ppm";

/** Fetch recent server logs for bug report */
async function fetchRecentLogs(): Promise<string> {
  try {
    const res = await fetch(LOGS_URL, { signal: AbortSignal.timeout(3000) });
    const json = await res.json();
    return json.ok ? json.data.logs : "(failed to fetch logs)";
  } catch {
    return "(server logs unavailable)";
  }
}

/** Open GitHub issue pre-filled with crash context + logs */
async function openBugReport() {
  const logs = await fetchRecentLogs();
  const title = encodeURIComponent("bug: server crashed unexpectedly");
  const body = encodeURIComponent([
    "## Environment",
    `- URL: ${window.location.href}`,
    `- UserAgent: ${navigator.userAgent}`,
    `- Time: ${new Date().toISOString()}`,
    "",
    "## Description",
    "The PPM server went down and restarted unexpectedly.",
    "",
    "## Steps to Reproduce",
    "1. ",
    "",
    "## Recent Server Logs",
    "```",
    logs,
    "```",
  ].join("\n"));
  window.open(`https://github.com/${REPO}/issues/new?title=${title}&body=${body}`, "_blank");
}

/**
 * WebSocket-based health check.
 * Uses a single persistent WS connection instead of HTTP polling
 * to avoid eating browser connection slots (6-conn limit per origin).
 */
export function useHealthCheck() {
  const wasDown = useRef(false);
  const isFirstCheck = useRef(true);
  const wsRef = useRef<WebSocket | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pongTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let unmounted = false;

    function clearTimers() {
      if (pingTimer.current) { clearInterval(pingTimer.current); pingTimer.current = null; }
      if (pongTimer.current) { clearTimeout(pongTimer.current); pongTimer.current = null; }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    }

    function markDown() {
      if (!wasDown.current && !isFirstCheck.current) {
        toast.error("Server unreachable", {
          description: "PPM server is not responding. It may have crashed.",
          duration: 10_000,
        });
      }
      wasDown.current = true;
    }

    function markUp() {
      if (wasDown.current && !isFirstCheck.current) {
        toast.warning("Server was restarted", {
          description: "PPM server went down and recovered. If unexpected, please report it.",
          duration: 15_000,
          action: { label: "Report Bug", onClick: () => openBugReport() },
        });
      }
      wasDown.current = false;
      isFirstCheck.current = false;
    }

    function connect() {
      if (unmounted) return;
      clearTimers();

      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/health`);
      wsRef.current = ws;

      ws.onopen = () => {
        markUp();
        // Start ping interval
        pingTimer.current = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send("ping");
          // Expect pong within timeout
          pongTimer.current = setTimeout(() => {
            markDown();
            ws.close();
          }, PONG_TIMEOUT);
        }, PING_INTERVAL);
      };

      ws.onmessage = () => {
        // Any message = server alive, clear pong timeout
        if (pongTimer.current) { clearTimeout(pongTimer.current); pongTimer.current = null; }
        if (wasDown.current) markUp();
      };

      ws.onclose = () => {
        clearTimers();
        if (!unmounted) {
          markDown();
          reconnectTimer = setTimeout(connect, RECONNECT_INTERVAL);
        }
      };

      ws.onerror = () => {
        // onclose will fire after onerror
      };
    }

    // Delay initial connect slightly so app renders first
    const initialDelay = setTimeout(connect, 1_000);

    return () => {
      unmounted = true;
      clearTimeout(initialDelay);
      clearTimers();
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on cleanup
        wsRef.current.close();
      }
    };
  }, []);
}
