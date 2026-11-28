import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { CardFileSmoothState } from "../../shared/card-files.ts";
import { cardFilePath, cardFileSmoothMarkerPath, cardFileSmoothPath, readCardFile, type StoredCardFile } from "./card-files-store.ts";
import { encodeSmoothCopy, type SmoothResult } from "./card-file-video-compress.ts";
import { createLogger } from "../logger.ts";

/**
 * The "Smooth" copy of a card's video (`<id>.smooth.mp4`): made in the background as soon as the
 * card holds the video, so a phone on a slow link can watch it while the original stays one tap
 * away (`/card-file/<id>`, Original / Smooth). A video already light enough is marked skipped
 * (`<id>.smooth.json`) rather than copied; a failure is marked too, with its reason.
 *
 * The jobs under way live in memory only. After a restart a video with neither a copy nor a mark
 * is "pending" and the next look at it (`/api/card-files/<id>/info`) starts its job again.
 */

const log = createLogger("card-files");
const running = new Map<string, Promise<void>>();

type Marker = { state: "skipped" | "failed"; why: string };

function readMarker(id: string): Marker | null {
  try { return JSON.parse(readFileSync(cardFileSmoothMarkerPath(id), "utf8")) as Marker; } catch { return null; }
}

/** Where the smooth copy of `file` stands. */
export function smoothState(file: Pick<StoredCardFile, "id" | "kind">): CardFileSmoothState {
  if (file.kind !== "video") return "none";
  if (existsSync(cardFileSmoothPath(file.id))) return "ready";
  if (readMarker(file.id)) return "none";
  return "pending";
}

/** Whether a job for `id` is under way in this process. */
export const smoothRunning = (id: string): boolean => running.has(id);

/**
 * Starts the smooth copy of `file` unless it exists, is marked, or is being made. Resolves when
 * that job ends; never rejects.
 */
export function ensureSmoothCopy(file: Pick<StoredCardFile, "id" | "kind">, encode: (input: string, output: string) => Promise<SmoothResult> = encodeSmoothCopy): Promise<void> {
  if (smoothState(file) !== "pending") return Promise.resolve();
  const existing = running.get(file.id);
  if (existing) return existing;
  const job = (async () => {
    const res = await encode(cardFilePath(file.id), cardFileSmoothPath(file.id)).catch((e): SmoothResult => ({ ok: false, why: (e as Error).message }));
    if (res.ok) return;
    // The original may have been pruned meanwhile; nothing to mark then.
    if (!existsSync(cardFilePath(file.id))) return;
    const marker: Marker = { state: "skipped" in res ? "skipped" : "failed", why: res.why };
    if (marker.state === "failed") log.warn(`card file ${file.id}: no smooth copy (${res.why})`);
    try { writeFileSync(cardFileSmoothMarkerPath(file.id), JSON.stringify(marker)); } catch { /* the folder went away */ }
  })().finally(() => running.delete(file.id));
  running.set(file.id, job);
  return job;
}

/** Starts the smooth copies of the videos among `ids` (a card just filed); never throws. */
export async function startSmoothCopies(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const file = await readCardFile(id);
    if (file?.kind === "video") void ensureSmoothCopy(file);
  }
}
