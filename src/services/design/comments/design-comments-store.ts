import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import {
  COMMENT_ID_RE, COMMENT_LIMITS, parseCommentAnchor, type DesignComment,
} from "../../../shared/design-comment-types.ts";
import { dotDesignDir, lstatOrNull } from "../design-paths.ts";
import { ensureDotDesign, writeFileAtomic } from "../design-fs.ts";
import { readDesignFileSafe } from "../design-safe-walk.ts";
import { DesignError } from "../design-error.ts";

/**
 * `designs/<slug>/.design/comments.json`: `{ version: 1, comments: [...] }`.
 *
 * The file is PPM's own data, but it sits in a folder an agent can write to, so it is read
 * as untrusted: every entry is re-validated and capped, and a file that does not parse is
 * treated as empty — after a copy is kept as `comments.json.bak`, so a hand edit gone wrong
 * is recoverable rather than silently replaced by the next save.
 */

export const COMMENTS_FILE = "comments.json";
const MAX_FILE_BYTES = 16 * 1024 * 1024;

type Raw = Record<string, unknown>;
const isRaw = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const isoOrUndefined = (v: unknown): string | undefined =>
  typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : undefined;

export function parseStoredComment(v: unknown): DesignComment | null {
  if (!isRaw(v) || typeof v.id !== "string" || !COMMENT_ID_RE.test(v.id)) return null;
  const anchor = parseCommentAnchor(v.anchor);
  const createdAt = isoOrUndefined(v.createdAt);
  if (!anchor || !createdAt || typeof v.body !== "string" || !v.body.trim()) return null;
  const comment: DesignComment = {
    id: v.id,
    file: anchor.file,
    anchor,
    body: v.body.slice(0, COMMENT_LIMITS.body),
    snippet: typeof v.snippet === "string" ? v.snippet.slice(0, COMMENT_LIMITS.snippet) : null,
    createdAt,
    updatedAt: isoOrUndefined(v.updatedAt) ?? createdAt,
  };
  const resolvedAt = isoOrUndefined(v.resolvedAt);
  const sentAt = isoOrUndefined(v.sentAt);
  if (resolvedAt) comment.resolvedAt = resolvedAt;
  if (sentAt) comment.sentAt = sentAt;
  return comment;
}

export async function readComments(designDir: string): Promise<DesignComment[]> {
  const dir = dotDesignDir(designDir);
  const dirStat = await lstatOrNull(dir);
  if (!dirStat) return [];
  // Same rule as every write into `.design/`: a link there would move the read elsewhere.
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new DesignError(403, "EDESIGNPATH", ".design must be a real directory");
  const path = join(dir, COMMENTS_FILE);
  if (!(await lstatOrNull(path))) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readDesignFileSafe(path, MAX_FILE_BYTES)));
  } catch (e) {
    console.warn(`[design] ${path} is unreadable (${(e as Error).message}); keeping a .bak and starting empty`);
    await copyFile(path, `${path}.bak`).catch((err: Error) => console.warn(`[design] could not back up ${path}: ${err.message}`));
    return [];
  }
  const list = isRaw(parsed) && Array.isArray(parsed.comments) ? parsed.comments : [];
  const seen = new Set<string>();
  const out: DesignComment[] = [];
  for (const raw of list.slice(0, COMMENT_LIMITS.maxComments)) {
    const comment = parseStoredComment(raw);
    if (comment && !seen.has(comment.id)) {
      seen.add(comment.id);
      out.push(comment);
    }
  }
  return out;
}

export async function writeComments(designDir: string, comments: readonly DesignComment[]): Promise<void> {
  const dir = await ensureDotDesign(designDir);
  await writeFileAtomic(join(dir, COMMENTS_FILE), `${JSON.stringify({ version: 1, comments }, null, 2)}\n`);
}
