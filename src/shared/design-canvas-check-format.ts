import { totalFindings, type CanvasCheckReport } from "./design-canvas-check";
import { neutralizeFences, UNTRUSTED_HEADER } from "./untrusted-text";

/**
 * The text an agent reads about a canvas check: the `design_check` tool's result, and the
 * `[Canvas check]` message PPM sends after a turn that left problems behind.
 *
 * Every finding was measured inside the design document, whose scripts can write anything
 * into the DOM, so the findings go into a fenced block under the untrusted-content header.
 */

export const AUTO_CHECK_PREFIX = "[Canvas check]";

function where(report: CanvasCheckReport, slug: string): string {
  const file = report.file.replace(/[\u0000-\u001f\u007f`]/g, "").slice(0, 200) || "index.html";
  const frame = report.frame.replace(/[^A-Za-z0-9 -]/g, "").slice(0, 40);
  const size = `${report.viewport.width}x${report.viewport.height}`;
  return `designs/${slug}/${file} at ${size} CSS px${frame ? ` (${frame} frame)` : ""}`;
}

function findingLines(report: CanvasCheckReport): string {
  return report.findings.map((f, i) => {
    const on = f.element ? `\n   on ${f.element}` : "";
    return `${i + 1}. [${f.kind}] ${f.message}${on}`;
  }).join("\n");
}

function fenced(report: CanvasCheckReport): string[] {
  const total = totalFindings(report);
  const lines = [
    `Findings (${UNTRUSTED_HEADER}):`,
    "```text",
    neutralizeFences(findingLines(report)),
    "```",
  ];
  if (total > report.findings.length) lines.push(`${total - report.findings.length} more findings were not listed.`);
  return lines;
}

/** The tool result's text. Says plainly when nothing was found. */
export function formatCanvasCheck(report: CanvasCheckReport, slug: string): string {
  const total = totalFindings(report);
  const lines = [
    `Canvas check of ${where(report, slug)}. Page size ${report.page.width}x${report.page.height}.`,
  ];
  if (total === 0) {
    lines.push("No layout problems or runtime errors were found.");
  } else {
    lines.push(`${total} ${total === 1 ? "problem" : "problems"} found. Fix each one in the design's files, then check again.`, "", ...fenced(report));
  }
  if (report.screenshot) {
    lines.push("", `A screenshot of the canvas (${report.screenshot.width}x${report.screenshot.height}) is attached.`);
  }
  if (report.screenshotNote) lines.push(`Screenshot: ${neutralizeFences(report.screenshotNote)}`);
  return lines.join("\n");
}

/** The follow-up message sent after a turn, or null when there is nothing to report. */
export function buildAutoCheckMessage(report: CanvasCheckReport, slug: string): string | null {
  const total = totalFindings(report);
  if (total === 0) return null;
  return [
    `${AUTO_CHECK_PREFIX} PPM looked at ${where(report, slug)} after your last turn and found ${total} ${total === 1 ? "problem" : "problems"}.`,
    "",
    ...fenced(report),
    "",
    "Fix these, then call design_check to confirm the canvas is clean.",
  ].join("\n");
}
