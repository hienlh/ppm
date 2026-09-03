import type { Stats } from "node:fs";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  assertAllowed,
  assertNotPpmSubtreeDeep,
  assertNotProtected,
  resolvePath,
} from "../fs-path-guard.service.ts";
import { eexist } from "./fs-core-ops.ts";

export interface UploadResult {
  path: string;
  size: number;
}

/**
 * Suffix for the in-progress write. The stream lands here first and is only renamed onto
 * the real name once it ends cleanly, so a client abort or a server crash mid-transfer never
 * leaves a truncated file where a complete one used to be (or overwrites one at all).
 */
const TMP_SUFFIX = ".ppm-upload-tmp";

/**
 * Create the target's parent only when it is actually missing. On Windows, Bun's recursive
 * `mkdir` throws `EEXIST` for a directory that exists with the ReadOnly attribute — which is
 * how Windows marks Desktop, Documents and Downloads — and that `EEXIST` would surface to the
 * client as a "file already exists" collision for a file that was never there. An `EEXIST`
 * from the create itself (the directory appeared meanwhile) is equally not a collision.
 */
async function ensureParentDir(parent: string, alreadyExists: boolean): Promise<void> {
  if (alreadyExists) return;
  try {
    await mkdir(parent, { recursive: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

/**
 * Pumps a web `ReadableStream` into a file via Bun's incremental writer, chunk by chunk. Reads
 * through `getReader()` rather than `for await`: the DOM lib's `ReadableStream` type does not
 * (yet) declare `Symbol.asyncIterator`, even though Bun implements it at runtime.
 */
async function pumpToFile(path: string, body: ReadableStream<Uint8Array>): Promise<number> {
  const sink = Bun.file(path).writer();
  const reader = body.getReader();
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sink.write(value);
    size += value.byteLength;
  }
  await sink.end();
  return size;
}

/**
 * Stream an upload body straight to disk at `path`. `body` is the raw web `ReadableStream`
 * off the request, pumped chunk-by-chunk into a Bun `FileSink` — there is no per-file size
 * limit here, disk is the only bound, and nothing sits fully in memory.
 *
 * This does *not* use `Bun.write(path, new Response(body))`, the more obvious one-liner:
 * verified against a real `Bun.serve()` request on this host (Bun 1.3.10, Windows), that call
 * never resolves — the handler enters it and simply hangs until the client's own timeout,
 * even for a body a few bytes long. A `FileSink` fed by the same stream's async iterator
 * completes normally, so that is the write path here; only `Bun.write` itself is implicated
 * (the round-trip through `Response` and back is the one thing this path skips).
 *
 * `FileSink` has no `createPath` option (unlike `Bun.write`), so missing parent directories
 * are created explicitly. The immediate parent existing as a *file* is checked before that
 * `mkdir`: libuv reports it as `ENOTDIR` on POSIX but `EEXIST` on Windows, and the client-facing
 * answer for "there's a file in the way" should not depend on the host OS.
 */
export async function uploadFile(
  path: string,
  body: ReadableStream<Uint8Array> | null,
  overwrite: boolean,
): Promise<UploadResult> {
  if (!body) {
    throw Object.assign(new Error("Missing request body"), { status: 400, code: "EINVAL" });
  }
  const target = resolvePath(path);
  assertAllowed(target);
  // Uploading into the PPM directory would let a client overwrite the config database, the
  // auth token or the stored provider credentials.
  await assertNotPpmSubtreeDeep(target);
  await assertNotProtected(target);

  const existing = await lstatOrNull(target);
  if (existing) {
    if (existing.isDirectory()) {
      throw Object.assign(new Error(`${target} is a directory`), { status: 400, code: "EISDIR" });
    }
    if (!overwrite) throw eexist(target);
  }

  const parentStat = await lstatOrNull(dirname(target));
  if (parentStat && !parentStat.isDirectory()) {
    throw Object.assign(new Error(`${dirname(target)} is not a directory`), {
      status: 400,
      code: "ENOTDIR",
    });
  }

  const tmpPath = `${target}${TMP_SUFFIX}`;
  await ensureParentDir(dirname(tmpPath), parentStat != null);

  let size: number;
  try {
    size = await pumpToFile(tmpPath, body);
  } catch (e) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw e;
  }

  try {
    // `rename` already replaces an existing *file* destination on both POSIX and Windows —
    // the collision was already refused above unless the caller opted into `overwrite`.
    await rename(tmpPath, target);
  } catch (e) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw e;
  }

  return { path: target, size };
}
