import { api, projectUrl, getAuthToken } from "./api-client";

const REPO = "hienlh/ppm";

/** Build bug report body with diagnostic info */
export async function buildBugReport(
  version: string | null,
  options?: { sessionId?: string; projectName?: string },
): Promise<string> {
  let serverLogs = "(could not fetch)";
  try {
    const token = getAuthToken();
    const res = await fetch("/api/logs/recent", token ? { headers: { Authorization: `Bearer ${token}` } } : {});
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

  return [
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
}

/** Open pre-filled GitHub issue in new tab */
export function openGithubIssue(body: string) {
  const url = `https://github.com/${REPO}/issues/new?title=${encodeURIComponent("bug: ")}&body=${encodeURIComponent(body)}`;
  window.open(url, "_blank");
}

/** Copy text to clipboard */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Open bug report popup globally via custom event */
export function openBugReportPopup(
  version: string | null,
  options?: { sessionId?: string; projectName?: string },
) {
  buildBugReport(version, options).then((body) => {
    window.dispatchEvent(new CustomEvent("open-bug-report", { detail: body }));
  });
}

/** @deprecated Use openBugReportPopup instead */
export async function openBugReport(
  version: string | null,
  options?: { sessionId?: string; projectName?: string },
) {
  openBugReportPopup(version, options);
}
