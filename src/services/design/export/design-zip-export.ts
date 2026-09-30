import { extname, join } from "node:path";
import archiver from "archiver";
import { isCredentialPath } from "../../fs-path-guard.service.ts";
import { DesignError } from "../design-error.ts";
import { KIT_DIR_ALIAS } from "../preview/design-preview-scope.ts";
import { lstatOrNull, resolveDesignDir, resolveDesignsRoot } from "../design-paths.ts";
import { readDesignFileSafe, safeWalkDesignTree } from "../design-safe-walk.ts";

/**
 * A design as a zip: `<slug>/**` plus the project's `tokens.css` and `DESIGN.md`, and the
 * shared `kit/` UI kit when the design actually links it, all rooted at `designs/` so every
 * `../tokens.css` and `../kit/…` link still resolves after unzipping.
 *
 * Every file comes from the shared safe walker and is read through `readDesignFileSafe`: no
 * symlink (a link to `ppm.db` or a key is never packed), no FIFO or device, nothing whose
 * real path leaves the design, no credential path. The design's own `.design/` working data
 * and every dotfile or dot-directory are left out. The tree is listed and sized before the
 * first byte is sent, so an oversized design is a clean 413 rather than a truncated download;
 * files are then read one at a time as the archive drains, so memory holds about one file.
 */

export const MAX_ZIP_FILES = 5000;
export const MAX_ZIP_BYTES = 512 * 1024 * 1024;
const SHARED_FILES = ["tokens.css", "DESIGN.md"];
/** Text files worth scanning for a `../kit/` reference; a byte pattern, not a parse. */
const KIT_REF_EXTENSIONS = new Set([".html", ".htm", ".css", ".js", ".mjs"]);
const KIT_REF_SCAN_BYTES = 512 * 1024;

interface ZipEntry {
  name: string;
  abs: string;
}

/** Whether any of the design's own text files mentions the shared kit at all, by substring. */
async function designReferencesKit(designDir: string): Promise<boolean> {
  for await (const entry of safeWalkDesignTree(designDir)) {
    if (entry.rel.split("/").some((part) => part.startsWith("."))) continue;
    if (!KIT_REF_EXTENSIONS.has(extname(entry.rel).toLowerCase()) || entry.size > KIT_REF_SCAN_BYTES) continue;
    const bytes = await readDesignFileSafe(entry.abs, KIT_REF_SCAN_BYTES);
    if (bytes.toString("utf8").includes("../kit/")) return true;
  }
  return false;
}

async function listZipEntries(projectPath: string, slug: string): Promise<ZipEntry[]> {
  const designDir = await resolveDesignDir(projectPath, slug);
  const root = await resolveDesignsRoot(projectPath);
  const entries: ZipEntry[] = [];
  let bytes = 0;
  const add = (name: string, abs: string, size: number): void => {
    bytes += size;
    if (entries.length >= MAX_ZIP_FILES || bytes > MAX_ZIP_BYTES) {
      throw new DesignError(413, "ETOOBIG", "Design is too large to export as a zip");
    }
    entries.push({ name, abs });
  };
  for await (const entry of safeWalkDesignTree(designDir)) {
    if (entry.rel.split("/").some((part) => part.startsWith("."))) continue;
    add(`${slug}/${entry.rel}`, entry.abs, entry.size);
  }
  for (const name of root ? SHARED_FILES : []) {
    const abs = join(root!, name);
    const st = await lstatOrNull(abs);
    // The same rule as the walker: a regular file or nothing, never a link followed out.
    if (!st || st.isSymbolicLink() || !st.isFile() || isCredentialPath(abs)) continue;
    add(name, abs, st.size);
  }
  const kitDir = root ? join(root, KIT_DIR_ALIAS) : null;
  if (kitDir && (await lstatOrNull(kitDir))?.isDirectory() && (await designReferencesKit(designDir))) {
    for await (const entry of safeWalkDesignTree(kitDir)) {
      if (entry.rel.split("/").some((part) => part.startsWith("."))) continue;
      add(`${KIT_DIR_ALIAS}/${entry.rel}`, entry.abs, entry.size);
    }
  }
  return entries;
}

/** Waits for archiver to take in one entry, so the next file is read only once it has. */
function entryDone(archive: archiver.Archiver): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEntry = (): void => { archive.off("error", onError); resolve(); };
    const onError = (e: Error): void => { archive.off("entry", onEntry); reject(e); };
    archive.once("entry", onEntry);
    archive.once("error", onError);
  });
}

/** The zip as a byte stream. Throws (before streaming) when the design is missing or too big. */
export async function createDesignZip(projectPath: string, slug: string): Promise<ReadableStream<Uint8Array>> {
  const entries = await listZipEntries(projectPath, slug);
  const archive = archiver("zip", { zlib: { level: 5 } });
  let cancelled = false;

  const feed = async (): Promise<void> => {
    for (const entry of entries) {
      if (cancelled) return;
      const bytes = await readDesignFileSafe(entry.abs, MAX_ZIP_BYTES);
      const done = entryDone(archive);
      archive.append(bytes, { name: entry.name });
      await done;
    }
    await archive.finalize();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      archive.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
        // Stop compressing while the client is behind; `pull` resumes.
        if ((controller.desiredSize ?? 1) <= 0) archive.pause();
      });
      archive.on("end", () => controller.close());
      archive.on("error", (e: Error) => controller.error(e));
      feed().catch((e: unknown) => {
        if (cancelled) return;
        console.error(`[design-export] zip ${slug}: ${(e as Error).message}`);
        archive.abort();
        controller.error(e);
      });
    },
    pull() {
      archive.resume();
    },
    cancel() {
      cancelled = true;
      archive.abort();
    },
  }, { highWaterMark: 1024 * 1024, size: (chunk) => chunk?.byteLength ?? 0 });
}
