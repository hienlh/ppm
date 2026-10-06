/**
 * The Report tab's pure half: which lines a snippet holds with its context, the issue body as
 * Markdown, and the link that opens it on GitHub. What the preview shows and what is sent are
 * the same function, with `mark` set for the preview.
 */
import { codeFence } from "@/lib/code-fence";
import { logSourceLabel, rawLogLine, type LogEntry, type LogSourceId } from "../../../shared/logs-model";
import { LOGS_ISSUE_REPO } from "../../../shared/logs-api";
import { redactLogText, redactedKinds, type RedactOptions } from "../../../shared/log-redact";
import { foldRepeats, plural, type LogRow } from "./logs-view-model";

/** Past about 8 KB a link stops working on GitHub's side, so the body is copied instead. */
export const ISSUE_URL_LIMIT = 8192;

export const SNIPPET_CONTEXTS = [0, 5, 20] as const;
export type SnippetContext = (typeof SNIPPET_CONTEXTS)[number];

/** One stretch of lines in the report: what was picked, plus the lines around it once fetched. */
export interface ReportSnippet {
  id: string;
  /** The one source the lines came from, or "all" for a mix. */
  src: LogSourceId | "all";
  rows: LogRow[];
  ctx: SnippetContext;
  /** Up to 20 records each side, fetched the first time context is asked for. */
  around: { before: LogEntry[]; after: LogEntry[] } | null;
}

export interface SnippetLine {
  row: LogRow;
  /** A context line rather than a picked one. */
  ctx: boolean;
}

export function snippetLines(s: ReportSnippet): SnippetLine[] {
  const before = s.ctx && s.around ? foldRepeats(s.around.before.slice(-s.ctx)) : [];
  const after = s.ctx && s.around ? foldRepeats(s.around.after.slice(0, s.ctx)) : [];
  return [
    ...before.map((row) => ({ row, ctx: true })),
    ...s.rows.map((row) => ({ row, ctx: false })),
    ...after.map((row) => ({ row, ctx: true })),
  ];
}

/** Records picked into a snippet, a folded row counting every copy. */
export function snippetCount(s: Pick<ReportSnippet, "rows">): number {
  return s.rows.reduce((a, r) => a + r.count, 0);
}

export function snippetSource(entries: readonly LogEntry[]): LogSourceId | "all" {
  const srcs = new Set(entries.map((e) => e.src));
  return srcs.size === 1 ? [...srcs][0]! : "all";
}

const utcClock = (ts: number) => new Date(ts).toISOString().slice(11, 19);

/** `AI & chat · 01:35:55–01:35:56 UTC`: a snippet's heading in the issue and in the AI's prompt. */
export function snippetHeading(s: ReportSnippet): string {
  const first = s.rows[0];
  const last = s.rows[s.rows.length - 1];
  const span = first && last ? ` · ${utcClock(first.entry.ts)}–${utcClock(last.lastTs)} UTC` : "";
  return `${logSourceLabel(s.src)}${span}`;
}

/** The lines as they read in the files — what the issue and the AI both get. */
export function snippetRawLines(s: ReportSnippet): string[] {
  return snippetLines(s).map((l) => rawLogLine(l.row.entry, l.row.count));
}

export interface ReportFields {
  title: string;
  labels: string[];
  what: string;
  steps: string;
  expected: string;
}

export interface ReportBodyInput {
  fields: ReportFields;
  snippets: readonly ReportSnippet[];
  environment: ReadonlyArray<readonly [string, string]>;
  redact: RedactOptions;
  /** Wrap every replacement in \u0001…\u0002 for the preview. */
  mark?: boolean;
}

export function reportBody({ fields, snippets, environment, redact, mark = false }: ReportBodyInput): string {
  const r = (s: string) => redactLogText(s, redact, mark);
  const out: string[] = [
    "### What happened", r(fields.what.trim()) || "_Not filled in_", "",
    "### Steps to reproduce", r(fields.steps.trim()) || "_Not filled in_", "",
  ];
  if (fields.expected.trim()) out.push("### Expected", r(fields.expected.trim()), "");
  if (snippets.length) {
    out.push("### Log lines");
    for (const s of snippets) {
      const lines = snippetRawLines(s).map(r);
      const fence = codeFence(lines.join("\n"));
      const n = snippetCount(s);
      out.push(
        "",
        `<details><summary>${snippetHeading(s)} · ${plural(n, "line")}${s.ctx ? ` and ${s.ctx} around` : ""}</summary>`,
        "",
        fence,
        ...lines,
        fence,
        "</details>",
      );
    }
    out.push("");
  }
  if (environment.length) out.push("### Environment", ...environment.map(([k, v]) => `- ${k}: ${r(v)}`), "");
  out.push(`<sub>Sent from PPM → Logs. Removed before sending: ${redactedKinds(redact).join(", ")}.</sub>`);
  return out.join("\n");
}

/** The new-issue link; `body` null leaves the body out (it is copied instead). */
export function issueUrl(title: string, labels: readonly string[], body: string | null): string {
  const parts = [`title=${encodeURIComponent(title)}`];
  if (labels.length) parts.push(`labels=${encodeURIComponent(labels.join(","))}`);
  if (body !== null) parts.push(`body=${encodeURIComponent(body)}`);
  return `https://github.com/${LOGS_ISSUE_REPO}/issues/new?${parts.join("&")}`;
}

/** The issue as one Markdown document, for Copy as Markdown. */
export function reportMarkdown(title: string, body: string): string {
  return `# ${title.trim() || "Bug report"}\n\n${body}`;
}
