import type { CanvasCheckReport } from "../../shared/design-canvas-check";

/**
 * The HTML previews mounted on this page, by file, so a request from the server — the AI's
 * `open_preview` tool — can find the tab showing a page and ask it how the page rendered.
 *
 * Each document a preview loads gets a sequence number from one counter for the whole page,
 * so "a load newer than the one I saw" is a plain comparison even across a preview that was
 * unmounted and mounted again. A caller reads {@link latestPreviewLoad} before it asks for a
 * reload and then waits for a load past it, so it never checks the document that was on
 * screen before the file changed.
 */

export type PreviewCheck = (opts: { screenshot: boolean; frame: string }) => Promise<CanvasCheckReport>;

export interface PreviewLoad {
  seq: number;
  /** The iframe fired `load` for this document: its scripts, styles and images are in. */
  loaded: boolean;
  check: PreviewCheck;
}

interface Waiter {
  key: string;
  after: number;
  done: (load: PreviewLoad | null) => void;
}

const loads = new Map<string, PreviewLoad>();
const waiters = new Set<Waiter>();
let counter = 0;

export function previewKey(projectName: string | null | undefined, filePath: string): string {
  return `${projectName ?? ""}\u0000${filePath}`;
}

/** A preview started loading a document; returns that load's sequence number. */
export function beginPreviewLoad(key: string, check: PreviewCheck): number {
  const seq = ++counter;
  loads.set(key, { seq, loaded: false, check });
  return seq;
}

/** The iframe's `load` fired for load `seq`. A load that was replaced meanwhile is ignored. */
export function finishPreviewLoad(key: string, seq: number): void {
  const load = loads.get(key);
  if (!load || load.seq !== seq) return;
  load.loaded = true;
  for (const waiter of [...waiters]) {
    if (waiter.key === key && seq > waiter.after) waiter.done(load);
  }
}

/** The preview unmounted; its last load is no longer there to check. */
export function endPreviewLoads(key: string, seq: number): void {
  if (loads.get(key)?.seq === seq) loads.delete(key);
}

/** The newest load of this file's preview, or 0 when none is mounted. */
export function latestPreviewLoad(key: string): number {
  return loads.get(key)?.seq ?? 0;
}

/**
 * The first load of this file's preview past `after` that has finished, or — when
 * `timeoutMs` runs out first — the newest one past `after` that only started (a page still
 * waiting on a slow CDN is better checked late than not at all), or null when none began.
 */
export function waitForPreviewLoad(key: string, after: number, timeoutMs: number): Promise<PreviewLoad | null> {
  const current = loads.get(key);
  if (current && current.seq > after && current.loaded) return Promise.resolve(current);
  return new Promise((resolve) => {
    const waiter: Waiter = {
      key, after,
      done: (load) => {
        clearTimeout(timer);
        waiters.delete(waiter);
        resolve(load);
      },
    };
    const timer = setTimeout(() => {
      const started = loads.get(key);
      waiter.done(started && started.seq > after ? started : null);
    }, timeoutMs);
    waiters.add(waiter);
  });
}
