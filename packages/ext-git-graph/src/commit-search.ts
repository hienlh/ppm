/**
 * Server-side commit search.
 *
 * The graph's find bar previously filtered only the commit rows already loaded,
 * so a match older than the current page simply did not exist as far as the user
 * could tell. These searches run in git itself, over the whole history.
 *
 * Every query value is passed as an *attached* argument (`--grep=<text>`), so a
 * value that begins with a dash cannot be re-read as an option. Control
 * characters are rejected outright — they have no place in any of these fields
 * and would corrupt the record framing on the way back.
 */
import { assertSafeFilePaths } from "./git-exec.ts";

export const SEARCH_RECORD_SEP = "\x1e";
export const SEARCH_FIELD_SEP = "\x1f";
export const SEARCH_FORMAT =
  `${SEARCH_RECORD_SEP}%H${SEARCH_FIELD_SEP}%an${SEARCH_FIELD_SEP}%ae${SEARCH_FIELD_SEP}%at${SEARCH_FIELD_SEP}%D${SEARCH_FIELD_SEP}%s`;

export const SEARCH_MODES = ["message", "author", "content", "file"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export interface SearchQuery {
  mode: SearchMode;
  text: string;
}

export interface SearchHit {
  hash: string;
  author: string;
  authorEmail: string;
  authorDate: number;
  refs: string[];
  subject: string;
}

export function isSearchMode(value: unknown): value is SearchMode {
  return typeof value === "string" && (SEARCH_MODES as readonly string[]).includes(value);
}

function assertSearchText(text: unknown): string {
  const s = String(text ?? "");
  if (!s.trim()) throw new Error("Enter something to search for.");
  if (/[\x00-\x1f\x7f]/.test(s)) throw new Error("Search text cannot contain control characters.");
  return s;
}

/**
 * Build the `git log` arguments for one search.
 * `projectPath` is only needed for `mode: "file"`, to keep the path inside the
 * repository.
 */
export function buildSearchArgs(
  query: SearchQuery,
  maxCount: number,
  projectPath: string,
): string[] {
  if (!isSearchMode(query.mode)) throw new Error(`Unknown search mode: "${String(query.mode)}"`);
  const text = assertSearchText(query.text);
  const limit = Number.isInteger(maxCount) && maxCount > 0 ? maxCount : 200;

  const args = ["log", "--all", `--format=${SEARCH_FORMAT}`, `--max-count=${limit}`];

  switch (query.mode) {
    case "message":
      args.push("--regexp-ignore-case", `--grep=${text}`);
      break;
    case "author":
      args.push("--regexp-ignore-case", `--author=${text}`);
      break;
    case "content":
      // -S counts occurrences, so it reports the commits that introduced or
      // removed the string rather than every commit whose diff mentions it.
      args.push(`-S${text}`);
      break;
    case "file":
      assertSafeFilePaths([text], projectPath);
      args.push("--", text);
      break;
  }

  return args;
}

export function parseSearchResults(stdout: string): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const record of stdout.split(SEARCH_RECORD_SEP)) {
    if (!record.trim()) continue;
    const fields = record.split("\n")[0]?.split(SEARCH_FIELD_SEP);
    if (!fields || fields.length < 6) continue;
    const refs = fields[4] ?? "";
    hits.push({
      hash: fields[0] ?? "",
      author: fields[1] ?? "",
      authorEmail: fields[2] ?? "",
      authorDate: Number(fields[3]) || 0,
      refs: refs ? refs.split(",").map((r) => r.trim()).filter(Boolean) : [],
      subject: fields[5] ?? "",
    });
  }
  return hits;
}
