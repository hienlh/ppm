import { api, projectUrl } from "./api-client";

const REPO = "hienlh/ppm";

/** Collect diagnostic info and open a pre-filled GitHub issue in a new tab */
export async function openBugReport(
  version: string | null,
  options?: { sessionId?: string; projectName?: string },
) {
  let serverLogs = "(could not fetch)";
  try {
    const res = await fetch("/api/logs/recent");
    const json = await res.json();
    if (json.ok) serverLogs = json.data.logs || "(empty)";
  } catch {}

  let sessionLogs = "";
  if (options?.sessionId && options?.projectName) {
    try {
      const data = await api.get<{ logs: string }>(
        `${projectUrl(options.projectName)}/chat/sessions/${options.sessionId}/logs?tail=100`,
      );
      if (data.logs) sessionLogs = data.logs;
    } catch {}
  }

  const body = [
    "## Environment",
    `- PPM: v${version ?? "unknown"}`,
    `- Browser: ${navigator.userAgent}`,
    "",
    "## Description",
    "<!-- Describe the bug -->",
    "",
    "## Steps to Reproduce",
    "1. ",
    "",
    "## Expected Behavior",
    "",
    ...(sessionLogs
      ? [
          `## Chat Session Logs (${options?.sessionId?.slice(0, 8)})`,
          "```",
          sessionLogs,
          "```",
          "",
        ]
      : []),
    "## Server Logs (last 30 lines)",
    "```",
    serverLogs,
    "```",
  ].join("\n");

  const url = `https://github.com/${REPO}/issues/new?title=${encodeURIComponent("bug: ")}&body=${encodeURIComponent(body)}`;
  window.open(url, "_blank");
}
