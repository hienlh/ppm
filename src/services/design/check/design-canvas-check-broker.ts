import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { emitDesignEvent } from "../design-events.ts";
import type { CanvasCheckReport } from "../../../shared/design-canvas-check.ts";

/**
 * The server half of the canvas self-check. The design is only ever laid out in a browser
 * tab, so a check is a round trip: announce `design:check_request` to the clients showing
 * that design (`/ws/global`), and wait for the first of them to POST its report back.
 *
 * A pending request is bound to its project and design; an answer naming any other one is
 * refused, so a client cannot settle a check it was never asked about. The map is bounded
 * and every entry leaves it on its own timer, answered or not.
 */

export const CHECK_TIMEOUT_MS = 20_000;
export const MAX_PENDING_CHECKS = 32;
export const NO_CANVAS_MESSAGE =
  "No open design canvas answered. Open this design's tab in PPM to check the canvas, then call design_check again.";

export type CanvasCheckOutcome = { ok: true; report: CanvasCheckReport } | { ok: false; error: string };

interface Pending {
  key: string;
  settle: (outcome: CanvasCheckOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

const fold = (p: string): string => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
const keyOf = (projectPath: string, slug: string): string => `${fold(projectPath)}\u0000${slug}`;

export function createCanvasCheckBroker(opts: {
  timeoutMs?: number;
  maxPending?: number;
  announce?: (projectPath: string, slug: string, requestId: string, screenshot: boolean) => void;
} = {}) {
  const timeoutMs = opts.timeoutMs ?? CHECK_TIMEOUT_MS;
  const maxPending = opts.maxPending ?? MAX_PENDING_CHECKS;
  const announce = opts.announce ?? ((projectPath, slug, requestId, screenshot) =>
    emitDesignEvent("check_request", { projectPath, slug, requestId, screenshot }));
  const pending = new Map<string, Pending>();

  function request(projectPath: string, slug: string, options: { screenshot: boolean }): Promise<CanvasCheckOutcome> {
    if (pending.size >= maxPending) {
      return Promise.resolve({ ok: false, error: "Too many canvas checks are waiting; try again in a few seconds." });
    }
    const requestId = randomBytes(12).toString("base64url");
    return new Promise<CanvasCheckOutcome>((done) => {
      const settle = (outcome: CanvasCheckOutcome): void => {
        const entry = pending.get(requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(requestId);
        done(outcome);
      };
      const timer = setTimeout(() => settle({ ok: false, error: NO_CANVAS_MESSAGE }), timeoutMs);
      pending.set(requestId, { key: keyOf(projectPath, slug), settle, timer });
      try {
        announce(projectPath, slug, requestId, options.screenshot);
      } catch (e) {
        settle({ ok: false, error: `Could not reach the canvas: ${(e as Error).message}` });
      }
    });
  }

  /** Settles a pending check with a client's report; false when none matches this design. */
  function resolveCheck(projectPath: string, slug: string, requestId: string, report: CanvasCheckReport): boolean {
    const entry = pending.get(requestId);
    if (!entry || entry.key !== keyOf(projectPath, slug)) return false;
    entry.settle({ ok: true, report });
    return true;
  }

  return { request, resolveCheck, pendingCount: () => pending.size };
}

export const canvasCheckBroker = createCanvasCheckBroker();
