import { useEffect, useRef } from "react";
import { api, projectUrl } from "@/lib/api-client";
import {
  CHECK_REQUEST_ID_RE, withRuntimeIssues, type CanvasCheckReport, type LayoutCheckReport,
} from "../../../../shared/design-canvas-check";
import { newBridgeNonce, type DesignBridge, type ReadyMessage } from "./use-design-bridge";
import type { CanvasIssue } from "./design-issues-badge";

/**
 * Running the canvas self-check from the parent, and answering the server when an agent's
 * `design_check` tool asks for one.
 *
 * The frame measures itself (`check-run` → `check-result`); the parent adds what only it
 * knows — the runtime issues it collected for this load and the device frame on screen. The
 * screenshot library is fetched only when a screenshot is wanted, as its own lazy chunk,
 * and handed to the frame as source because the frame can load nothing from PPM's origin.
 */

const CHECK_TIMEOUT_MS = 15_000;
/** How long a canvas that is (re)loading gets to say `ready` before a request gives up. */
const READY_WAIT_MS = 8_000;

let libSource: Promise<string> | null = null;
function screenshotLib(): Promise<string> {
  libSource ??= import("modern-screenshot/dist/index.js?raw").then((m) => m.default).catch((e: unknown) => {
    libSource = null;
    throw e;
  });
  return libSource;
}

export interface CanvasCheckContext {
  issues: readonly CanvasIssue[];
  /** The device frame's label, e.g. "Desktop". */
  frame: string;
}

/**
 * The frame's current `ready`, or its next one if it is (re)loading; null if none comes in
 * time. `bridge` may be a render old, so a load that completes meanwhile is taken from the
 * event rather than from `bridge.ready`.
 */
function whenReady(bridge: DesignBridge): Promise<ReadyMessage | null> {
  if (bridge.ready) return Promise.resolve(bridge.ready);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { off(); resolve(null); }, READY_WAIT_MS);
    const off = bridge.on("ready", (m) => { clearTimeout(timer); off(); resolve(m); });
  });
}

export async function runCanvasCheck(
  bridge: DesignBridge,
  ctx: CanvasCheckContext,
  opts: { screenshot: boolean },
): Promise<CanvasCheckReport> {
  const lib = opts.screenshot ? await screenshotLib().catch(() => undefined) : undefined;
  const ready = await whenReady(bridge);
  if (!ready) throw new Error("The canvas is still loading");
  const report = await new Promise<LayoutCheckReport>((resolve, reject) => {
    const requestId = newBridgeNonce();
    const cleanup = (): void => { offResult(); offError(); clearTimeout(timer); };
    const offResult = bridge.on("check-result", (m) => { if (m.requestId === requestId) { cleanup(); resolve(m.report); } });
    const offError = bridge.on("check-error", (m) => { if (m.requestId === requestId) { cleanup(); reject(new Error(m.message)); } });
    const timer = setTimeout(() => { cleanup(); reject(new Error("The canvas did not answer in time")); }, CHECK_TIMEOUT_MS);
    if (!bridge.send({ type: "check-run", requestId, screenshot: opts.screenshot, ...(lib ? { lib } : {}) })) {
      cleanup();
      reject(new Error("The canvas is not accepting messages"));
    }
  });
  const runtime = ctx.issues.filter((i) => i.kind !== "navigate-blocked" && i.kind !== "layout");
  const withIssues = withRuntimeIssues(report, runtime);
  const note = opts.screenshot && !lib ? "The screenshot library could not be loaded." : withIssues.screenshotNote;
  return { ...withIssues, ...(note ? { screenshotNote: note } : {}), file: ready.file, gen: ready.gen, frame: ctx.frame };
}

/**
 * Answers `design:check_request` for this design: the server asks every browser showing it,
 * and the first report posted back settles the agent's tool call. A tab that cannot check
 * (still loading, frame dead) stays silent rather than answer with an error, so another
 * device that can still wins.
 */
export function useDesignCanvasCheckResponder(opts: {
  projectName: string;
  slug: string;
  bridge: DesignBridge;
  context: () => CanvasCheckContext;
}): void {
  const ref = useRef(opts);
  ref.current = opts;
  const { projectName, slug } = opts;

  useEffect(() => {
    const onRequest = (e: Event) => {
      const d = (e as CustomEvent<{ projectName?: unknown; slug?: unknown; requestId?: unknown; screenshot?: unknown }>).detail;
      if (!d || d.projectName !== projectName || d.slug !== slug) return;
      if (typeof d.requestId !== "string" || !CHECK_REQUEST_ID_RE.test(d.requestId)) return;
      const requestId = d.requestId;
      const { bridge, context } = ref.current;
      runCanvasCheck(bridge, context(), { screenshot: d.screenshot === true })
        .then((report) => api.post(`${projectUrl(projectName)}/designs/${encodeURIComponent(slug)}/check/${requestId}`, report))
        .catch((err: unknown) => {
          // A 404 means another client answered first; anything else is worth a line.
          const message = (err as Error)?.message ?? String(err);
          if (!/pending check/i.test(message)) console.warn(`[design] canvas check for ${slug} not sent: ${message}`);
        });
    };
    window.addEventListener("design:check_request", onRequest);
    return () => window.removeEventListener("design:check_request", onRequest);
  }, [projectName, slug]);
}
