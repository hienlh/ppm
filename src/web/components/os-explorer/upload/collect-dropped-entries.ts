/**
 * Turns an OS `Files` drop (or a picked `FileList`) into a flat list of `{file, relativePath}`
 * pairs, walking nested folders when the browser exposes `webkitGetAsEntry`. Falls back to a
 * flat `dataTransfer.files` list — no relative path beyond the bare name — on a browser that
 * never implemented the entries API.
 */

export interface DroppedEntry {
  file: File;
  /** Forward-slash path relative to the drop target, including the file's own name. A flat
   *  drop (no folder) is just the bare file name. */
  relativePath: string;
}

/**
 * Reject directory traversal and normalise separators. A dropped folder's real
 * `FileSystemEntry.fullPath` never contains `..`, but a rebuilt/spoofed `DataTransfer` (or a
 * test) might, and this is the one seam every path this module produces passes through.
 * Returns `null` when nothing safe is left (empty, or only `..`/`.` segments).
 */
export function sanitizeRelativePath(raw: string): string | null {
  const unified = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = unified.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) return null;
  return segments.join("/");
}

function readEntryAsFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** `readEntries` only ever returns one batch per call — the empty batch that signals the end
 *  is itself the loop's exit condition, not a sentinel value. */
function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const readNextBatch = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) { resolve(all); return; }
        all.push(...batch);
        readNextBatch();
      }, reject);
    };
    readNextBatch();
  });
}

async function walk(entry: FileSystemEntry, out: DroppedEntry[]): Promise<void> {
  if (entry.isFile) {
    const relativePath = sanitizeRelativePath(entry.fullPath);
    if (!relativePath) return;
    out.push({ file: await readEntryAsFile(entry as FileSystemFileEntry), relativePath });
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (const child of await readAllEntries(reader)) await walk(child, out);
  }
}

/** Entry point: prefers the entries API (nested folders survive), falls back to a flat list. */
export async function collectDroppedEntries(dataTransfer: DataTransfer): Promise<DroppedEntry[]> {
  const entries = Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === "file" && typeof item.webkitGetAsEntry === "function")
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry != null);

  if (entries.length > 0) {
    const out: DroppedEntry[] = [];
    for (const entry of entries) await walk(entry, out);
    return out;
  }

  // No entries API (or every item resolved to null) — flat files only, no folder structure.
  const flat: DroppedEntry[] = [];
  for (const file of Array.from(dataTransfer.files)) {
    const relativePath = sanitizeRelativePath(file.name);
    if (relativePath) flat.push({ file, relativePath });
  }
  return flat;
}
