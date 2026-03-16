const REPO = "hienlh/ppm";

/** Collect diagnostic info and open a pre-filled GitHub issue in a new tab */
export async function openBugReport(version: string | null) {
  let logs = "(could not fetch)";
  try {
    const res = await fetch("/api/logs/recent");
    const json = await res.json();
    if (json.ok) logs = json.data.logs || "(empty)";
  } catch {}

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
    "## Recent Logs (last 30 lines)",
    "```",
    logs,
    "```",
  ].join("\n");

  const url = `https://github.com/${REPO}/issues/new?title=${encodeURIComponent("bug: ")}&body=${encodeURIComponent(body)}`;
  window.open(url, "_blank");
}
