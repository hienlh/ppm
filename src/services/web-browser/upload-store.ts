/**
 * Files a viewer picked for a page's file input: written to the browser's own folder as
 * `uploads/<uuid>/<cleaned name>` (the extension kept, since sites check it), handed to the page
 * with `DOM.setFileInputFiles`, and removed after an hour.
 */
import { randomUUIDv7 } from "bun";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { webBrowserPaths } from "./chrome-launch-args.ts";

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** All uploads waiting at once; they are removed an hour after arriving. */
export const MAX_TOTAL_UPLOAD_BYTES = 1024 * 1024 * 1024;

function uploadsTotalBytes(): number {
  const root = webBrowserPaths.uploads();
  let total = 0;
  let ids: string[] = [];
  try { ids = readdirSync(root); } catch { return 0; }
  for (const id of ids) {
    try { for (const f of readdirSync(join(root, id))) total += statSync(join(root, id, f)).size; } catch {}
  }
  return total;
}
const KEEP_MS = 3600_000;

/** A file name safe on every OS: no path, no reserved characters, at most 120 characters. */
export function cleanFileName(raw: string): string {
  const base = basename(raw.replace(/\\/g, "/")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+/, "").trim();
  const name = base || "file";
  if (name.length <= 120) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : "";
  return name.slice(0, 120 - ext.length) + ext;
}

/** Streams `body` to disk; throws when it exceeds the cap. Returns the upload id. */
export async function saveUpload(body: ReadableStream<Uint8Array>, rawName: string): Promise<string> {
  pruneUploads();
  const already = uploadsTotalBytes();
  if (already >= MAX_TOTAL_UPLOAD_BYTES) throw new Error("too many uploads are waiting; try again in a while");
  const id = randomUUIDv7();
  const dir = join(webBrowserPaths.uploads(), id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, cleanFileName(rawName));
  const sink = Bun.file(path).writer();
  let total = 0;
  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_UPLOAD_BYTES) throw new Error(`files over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB are not accepted`);
      if (already + total > MAX_TOTAL_UPLOAD_BYTES) throw new Error("too many uploads are waiting; try again in a while");
      sink.write(value);
      await sink.flush();
    }
    await sink.end();
    return id;
  } catch (error) {
    try { await sink.end(); } catch {}
    try { await reader.cancel(); } catch {}
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** The absolute path of an upload, or null. */
export function uploadPath(id: string): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const dir = join(webBrowserPaths.uploads(), id);
  try {
    const [name] = readdirSync(dir);
    return name ? join(dir, name) : null;
  } catch {
    return null;
  }
}

export function pruneUploads(now = Date.now()): void {
  const root = webBrowserPaths.uploads();
  let ids: string[] = [];
  try { ids = readdirSync(root); } catch { return; }
  for (const id of ids) {
    try {
      if (now - statSync(join(root, id)).mtimeMs > KEEP_MS) rmSync(join(root, id), { recursive: true, force: true });
    } catch {}
  }
}
