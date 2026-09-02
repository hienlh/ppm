import { readFileSync, statSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import {
  assertAllowed,
  assertNotPpmDir,
  realPathOrSelf,
  realPathOrSelfSync,
  resolvePath,
} from "../fs-path-guard.service.ts";

// Re-exported because the raw/docx routes resolve a path before serving it.
export { realPathOrSelf };

/** Refuse to page a huge file into memory as a string. */
const READ_MAX_SIZE = 5 * 1024 * 1024;

export interface SystemFileContent {
  content: string;
  path: string;
}

/**
 * Whitelist and PPM-dir shield, applied to the requested path *and* to the
 * path it really resolves to — otherwise a symlink parked in a public
 * directory would hand out the credentials database.
 */
export function assertReadPermitted(resolved: string, real: string): void {
  assertAllowed(resolved);
  assertNotPpmDir(resolved);
  assertAllowed(real);
  assertNotPpmDir(real);
}

/** Type and size gate shared by both readers. */
function assertReadable(isFile: boolean, size: number): void {
  if (!isFile) {
    throw Object.assign(new Error("Not a file"), { status: 400, code: "EISDIR" });
  }
  if (size > READ_MAX_SIZE) {
    throw Object.assign(new Error("File too large (>5MB)"), { status: 400, code: "EFBIG" });
  }
}

/** Read a file outside project scope without blocking the event loop. */
export async function readSystemFile(filePath: string): Promise<SystemFileContent> {
  const resolved = resolvePath(filePath);
  assertReadPermitted(resolved, await realPathOrSelf(resolved));
  const st = await stat(resolved);
  assertReadable(st.isFile(), st.size);
  return { content: await readFile(resolved, "utf-8"), path: resolved };
}

/**
 * Blocking variant kept for the project-scoped diff route, which composes its
 * result synchronously. New callers should use the async version.
 */
export function readSystemFileSync(filePath: string): SystemFileContent {
  const resolved = resolvePath(filePath);
  assertReadPermitted(resolved, realPathOrSelfSync(resolved));
  const st = statSync(resolved);
  assertReadable(st.isFile(), st.size);
  return { content: readFileSync(resolved, "utf-8"), path: resolved };
}

/** Write a file outside project scope. */
export async function writeSystemFile(filePath: string, content: string): Promise<void> {
  const resolved = resolvePath(filePath);
  assertReadPermitted(resolved, await realPathOrSelf(resolved));
  await writeFile(resolved, content, "utf-8");
}
