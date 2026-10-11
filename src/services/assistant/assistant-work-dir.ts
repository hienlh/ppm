import { mkdirSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { getPpmDir } from "../ppm-dir.ts";
import { getDbPath } from "../db.service.ts";

/**
 * The working directory every PPM Assistant session runs in: an empty folder under the PPM
 * dir, named after the database this server opened.
 *
 * Named per database because a dev server (`ppm.dev.db`) and the production one (`ppm.db`)
 * share the PPM dir, and both providers list a project's sessions by working directory —
 * Claude by the encoded cwd under `~/.claude/projects`, Codex by `session_meta.cwd`. One
 * shared folder would show production's Assistant chats in the dev list and the reverse.
 * Reading `getDbPath()` opens nothing: it only names the file the profile selects.
 */
export function assistantWorkDir(): string {
  const dbFile = basename(getDbPath());
  return resolve(join(getPpmDir(), "assistant", basename(dbFile, extname(dbFile))));
}

/** {@link assistantWorkDir}, created if missing — both CLIs refuse a cwd that does not exist. */
export function ensureAssistantWorkDir(): string {
  const dir = assistantWorkDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}
