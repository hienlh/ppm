/**
 * The canvas self-check's report: what the bridge measured in the live design document,
 * plus what the parent adds (runtime issues the bridge already reported, the device frame).
 *
 * Everything in a report was produced inside the design frame, where the page's own scripts
 * run, so it is untrusted: {@link parseLayoutCheckReport} and {@link parseCanvasCheckReport}
 * cap every field and are run by the parent (frame message) and again by the server (POST
 * body). The text built from a report for an agent fences it as page content.
 */

import { DESIGN_GEN_RE } from "./design-types";

export const CHECK_KINDS = [
  "implicit-grid", "runtime", "page-overflow", "offscreen", "clipped", "collapsed", "overlap",
] as const;
export type CanvasCheckKind = (typeof CHECK_KINDS)[number];

export const MAX_CHECK_FINDINGS = 30;
export const MAX_FINDING_CHARS = 300;
export const MAX_ELEMENT_CHARS = 200;
/** The decoded image may be at most this big; the data URL is base64, a third larger. */
export const MAX_SCREENSHOT_BYTES = 400 * 1024;
export const MAX_SCREENSHOT_WIDTH = 1280;
/** Shape of a check request id: minted by whoever asks, echoed by whoever answers. */
export const CHECK_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface CanvasCheckFinding {
  kind: CanvasCheckKind;
  message: string;
  /** The element it is about: tag, id/classes, `data-ppm-id`, a little text. */
  element?: string;
}

export interface CanvasCheckScreenshot {
  dataUrl: string;
  width: number;
  height: number;
}

/** What the bridge measures. */
export interface LayoutCheckReport {
  viewport: { width: number; height: number };
  page: { width: number; height: number };
  findings: CanvasCheckFinding[];
  /** Findings per kind before the cap, so a truncated list still says how much was cut. */
  counts: Partial<Record<CanvasCheckKind, number>>;
  screenshot?: CanvasCheckScreenshot;
  /** Why there is no screenshot, or what it may get wrong. */
  screenshotNote?: string;
}

/** What the parent sends on: the bridge's report plus the document and frame it came from. */
export interface CanvasCheckReport extends LayoutCheckReport {
  file: string;
  gen: string | null;
  /** The device frame the canvas was showing (desktop, tablet, phone, slide). */
  frame: string;
}

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const dim = (v: unknown, max = 100_000): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : null;
const text = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);
const kindOf = (v: unknown): CanvasCheckKind | undefined => CHECK_KINDS.find((k) => k === v);
const DATA_URL_RE = /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_DATA_URL_CHARS = Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4 + 32;

function parseSize(v: unknown): { width: number; height: number } | null {
  if (!isObj(v)) return null;
  const width = dim(v.width), height = dim(v.height);
  return width === null || height === null ? null : { width, height };
}

function parseScreenshot(v: unknown): CanvasCheckScreenshot | undefined {
  if (!isObj(v) || typeof v.dataUrl !== "string") return undefined;
  if (v.dataUrl.length > MAX_DATA_URL_CHARS || !DATA_URL_RE.test(v.dataUrl)) return undefined;
  const width = dim(v.width, 4096), height = dim(v.height, 8192);
  if (!width || !height) return undefined;
  return { dataUrl: v.dataUrl, width, height };
}

/** A validated bridge report, or null. Findings beyond the cap and unknown kinds are dropped. */
export function parseLayoutCheckReport(raw: unknown): LayoutCheckReport | null {
  if (!isObj(raw) || !Array.isArray(raw.findings)) return null;
  const viewport = parseSize(raw.viewport), page = parseSize(raw.page);
  if (!viewport || !page) return null;
  const findings: CanvasCheckFinding[] = [];
  for (const f of raw.findings.slice(0, MAX_CHECK_FINDINGS)) {
    if (!isObj(f)) continue;
    const kind = kindOf(f.kind), message = text(f.message, MAX_FINDING_CHARS);
    if (!kind || !message) continue;
    const element = text(f.element, MAX_ELEMENT_CHARS);
    findings.push(element ? { kind, message, element } : { kind, message });
  }
  const counts: Partial<Record<CanvasCheckKind, number>> = {};
  if (isObj(raw.counts)) {
    for (const kind of CHECK_KINDS) {
      const n = dim(raw.counts[kind], 1_000_000);
      if (n) counts[kind] = n;
    }
  }
  const report: LayoutCheckReport = { viewport, page, findings, counts };
  const screenshot = parseScreenshot(raw.screenshot);
  if (screenshot) report.screenshot = screenshot;
  const note = text(raw.screenshotNote, MAX_FINDING_CHARS);
  if (note) report.screenshotNote = note;
  return report;
}

export function parseCanvasCheckReport(raw: unknown): CanvasCheckReport | null {
  const base = parseLayoutCheckReport(raw);
  if (!base || !isObj(raw)) return null;
  const file = text(raw.file, 512) ?? "";
  const gen = typeof raw.gen === "string" && DESIGN_GEN_RE.test(raw.gen) ? raw.gen : null;
  const frame = text(raw.frame, 40) ?? "";
  return { ...base, file, gen, frame };
}

export interface RuntimeIssueInput {
  kind: string;
  message: string;
  source?: string;
  line?: number;
}

/**
 * Fold the runtime issues the parent collected for this load into a bridge report, in the
 * order {@link CHECK_KINDS} lists, keeping the overall cap.
 */
export function withRuntimeIssues(report: LayoutCheckReport, issues: readonly RuntimeIssueInput[]): LayoutCheckReport {
  const runtime: CanvasCheckFinding[] = issues.map((issue) => {
    const where = issue.source ? ` (${issue.source}${issue.line ? `:${issue.line}` : ""})` : "";
    return { kind: "runtime", message: `${issue.kind}: ${issue.message}${where}`.slice(0, MAX_FINDING_CHARS) };
  });
  const all = [...report.findings, ...runtime];
  const rank = (f: CanvasCheckFinding) => CHECK_KINDS.indexOf(f.kind);
  const sorted = all.map((f, i) => ({ f, i })).sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i).map((x) => x.f);
  const counts = { ...report.counts };
  if (runtime.length) counts.runtime = (counts.runtime ?? 0) + runtime.length;
  return { ...report, findings: sorted.slice(0, MAX_CHECK_FINDINGS), counts };
}

/** Findings the report counted, including those cut by the cap. */
export function totalFindings(report: Pick<LayoutCheckReport, "counts" | "findings">): number {
  const counted = Object.values(report.counts).reduce((sum, n) => sum + (n ?? 0), 0);
  return Math.max(counted, report.findings.length);
}
