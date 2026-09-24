import type { BridgeApi } from "./bridge-core.ts";
import type { ScreenshotLib } from "./bridge-layout-screenshot.ts";
import type { CheckAdd } from "./bridge-layout-grid.ts";

/**
 * The canvas self-check, answering the parent's `check-run`.
 *
 * The design agent runs on the server and never sees what it built; the only place the
 * design is actually laid out is this frame in the user's browser. So the frame measures
 * itself — the grid and box rules from `ppm.lib` — and, when asked, draws a screenshot with
 * the library whose source the parent sends along. The report is capped (30 findings, 300
 * characters each, every finding still counted by kind) and validated again by the parent
 * and the server: a page script can post the same shape, so it is only ever data.
 *
 * Shipped as source, so nothing here may reference this module's scope.
 */
export function installLayoutCheck(ppm: BridgeApi): void {
  const win = ppm.win as Window & { modernScreenshot?: ScreenshotLib };
  const doc = ppm.doc;
  const MAX = 30;
  let shotLib: ScreenshotLib | null = null;

  function measure() {
    const findings: Array<{ kind: string; message: string; element?: string }> = [];
    const counts: Record<string, number> = {};
    const add: CheckAdd = (kind, message, el) => {
      counts[kind] = (counts[kind] || 0) + 1;
      if (findings.length >= MAX) return;
      const finding: { kind: string; message: string; element?: string } = {
        kind, message: message.length > 300 ? message.slice(0, 299) + "…" : message,
      };
      if (el) finding.element = ppm.lib.checkLabel(el, true);
      findings.push(finding);
    };
    const rules = [ppm.lib.gridImplicitFindings, ppm.lib.boxFindings];
    for (let i = 0; i < rules.length; i++) {
      try {
        rules[i]!(ppm, add);
      } catch (e) {
        ppm.issue("error", "canvas check rule failed: " + (e && (e as Error).message));
      }
    }
    const de = doc.documentElement;
    return {
      viewport: { width: win.innerWidth, height: win.innerHeight },
      page: { width: de ? de.scrollWidth : 0, height: de ? de.scrollHeight : 0 },
      findings, counts,
    } as Record<string, unknown>;
  }

  /** Runs the library once per document; the UMD wrapper is kept off any page-defined loader. */
  function loadLib(source: unknown): ScreenshotLib | null {
    if (shotLib) return shotLib;
    if (typeof source !== "string" || !source) return null;
    const previous = win.modernScreenshot;
    try {
      new Function("exports", "module", "define", source).call(win, undefined, undefined, undefined);
      const lib = win.modernScreenshot;
      shotLib = lib && typeof lib.domToCanvas === "function" && typeof lib.createContext === "function" ? lib : null;
    } finally {
      win.modernScreenshot = previous;
    }
    return shotLib;
  }

  ppm.on("check-run", (m) => {
    const requestId = m.requestId;
    if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) return;
    let report: Record<string, unknown>;
    try {
      report = measure();
    } catch (e) {
      ppm.post("check-error", { requestId, message: String((e && (e as Error).message) || e).slice(0, 300) });
      return;
    }
    if (m.screenshot !== true) {
      ppm.post("check-result", { requestId, report });
      return;
    }
    let lib: ScreenshotLib | null = null;
    try {
      lib = loadLib(m.lib);
    } catch (e) {
      report.screenshotNote = "The screenshot library failed to load: " + String((e && (e as Error).message) || e).slice(0, 200);
    }
    if (!lib) {
      if (!report.screenshotNote) report.screenshotNote = "No screenshot: the screenshot library was not available.";
      ppm.post("check-result", { requestId, report });
      return;
    }
    ppm.lib.captureScreenshot(ppm, lib).then(
      (shot) => {
        report.screenshot = { dataUrl: shot.dataUrl, width: shot.width, height: shot.height };
        report.screenshotNote = shot.note;
      },
      (e) => { report.screenshotNote = "The screenshot failed: " + String((e && (e as Error).message) || e).slice(0, 200); },
    ).then(() => ppm.post("check-result", { requestId, report }));
  });
}
