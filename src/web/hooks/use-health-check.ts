import { useEffect, useRef } from "react";
import { toast } from "sonner";

const POLL_INTERVAL = 5_000;
const HEALTH_URL = "/api/health";
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
 * Periodically pings /api/health. When server goes down and comes back,
 * shows a toast suggesting the user report a bug.
 */
export function useHealthCheck() {
  const wasDown = useRef(false);
  const isFirstCheck = useRef(true);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;

    async function check() {
      try {
        const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          if (wasDown.current && !isFirstCheck.current) {
            toast.warning("Server was restarted", {
              description: "PPM server went down and recovered. If unexpected, please report it.",
              duration: 15_000,
              action: {
                label: "Report Bug",
                onClick: () => openBugReport(),
              },
            });
            wasDown.current = false;
          }
          isFirstCheck.current = false;
        } else {
          wasDown.current = true;
        }
      } catch {
        if (!wasDown.current && !isFirstCheck.current) {
          toast.error("Server unreachable", {
            description: "PPM server is not responding. It may have crashed.",
            duration: 10_000,
          });
        }
        wasDown.current = true;
      }
    }

    const initialDelay = setTimeout(() => {
      check();
      timer = setInterval(check, POLL_INTERVAL);
    }, POLL_INTERVAL);

    return () => {
      clearTimeout(initialDelay);
      clearInterval(timer);
    };
  }, []);
}
