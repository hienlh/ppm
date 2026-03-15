import { useEffect, useRef } from "react";
import { toast } from "sonner";

const POLL_INTERVAL = 5_000; // 5 seconds
const HEALTH_URL = "/api/health";

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
            // Server recovered after being down
            toast.warning("Server was restarted", {
              description: "PPM server went down and recovered. If this was unexpected, please report it.",
              duration: 15_000,
              action: {
                label: "Report Bug",
                onClick: () => {
                  const title = encodeURIComponent("bug: server crashed unexpectedly");
                  const body = encodeURIComponent([
                    "## Environment",
                    `- URL: ${window.location.href}`,
                    `- UserAgent: ${navigator.userAgent}`,
                    "",
                    "## Description",
                    "The PPM server went down and restarted unexpectedly.",
                    "",
                    "## Additional Context",
                    "<!-- Run `ppm logs` to attach recent server logs -->",
                  ].join("\n"));
                  window.open(`https://github.com/hienlh/ppm/issues/new?title=${title}&body=${body}`, "_blank");
                },
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

    // Start polling after initial delay
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
