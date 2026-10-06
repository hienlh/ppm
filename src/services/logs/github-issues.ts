/**
 * The two things the Report tab asks GitHub before a report is sent: which labels the repository
 * has, and whether an open issue already looks like this one. Both go through the server so a
 * browser on a plain-HTTP LAN origin can ask too, and both are cached — the search API allows an
 * anonymous caller ten requests a minute. Nothing is ever posted: the issue itself is opened in
 * the person's own browser, for them to read and submit.
 */
import { createLogger } from "../logger.ts";
import { LOGS_ISSUE_REPO, type DuplicateSearchResult } from "../../shared/logs-api.ts";

const log = createLogger("logs");

export const ISSUE_REPO = LOGS_ISSUE_REPO;
const API = "https://api.github.com";
const LABELS_TTL_MS = 6 * 60 * 60 * 1000;
const SEARCH_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 8000;
/** GitHub's defaults, which this repository has; used when the label list cannot be read. */
const FALLBACK_LABELS = ["bug", "enhancement", "question", "documentation"];

let labelsCache: { at: number; names: string[] } | null = null;
const searchCache = new Map<string, { at: number; result: DuplicateSearchResult }>();

async function gh(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "ppm-logs", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return res.json();
}

export async function repoLabels(): Promise<string[]> {
  if (labelsCache && Date.now() - labelsCache.at < LABELS_TTL_MS) return labelsCache.names;
  try {
    const list = (await gh(`/repos/${ISSUE_REPO}/labels?per_page=100`)) as Array<{ name?: unknown }>;
    const names = list.map((l) => (typeof l.name === "string" ? l.name : "")).filter(Boolean);
    labelsCache = { at: Date.now(), names: names.length ? names : FALLBACK_LABELS };
  } catch (e) {
    log.debug(`label list not read: ${(e as Error).message}`);
    return labelsCache?.names ?? FALLBACK_LABELS;
  }
  return labelsCache.names;
}

/**
 * Words only, so no `repo:`/`is:` qualifier can ride in on a title. GitHub ANDs the terms, so a
 * long title would match nothing; the first six words are the subject in practice.
 */
export function searchTerms(text: string): string {
  return text
    .replace(/[^\p{L}\p{N}\s._-]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 6)
    .join(" ")
    .slice(0, 120);
}

export async function searchDuplicates(text: string): Promise<DuplicateSearchResult> {
  const query = searchTerms(text);
  if (!query) return { query, issues: [] };
  const hit = searchCache.get(query);
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.result;
  const q = encodeURIComponent(`${query} repo:${ISSUE_REPO} is:issue is:open`);
  const data = (await gh(`/search/issues?q=${q}&per_page=5`)) as { items?: Array<Record<string, unknown>> };
  const result: DuplicateSearchResult = {
    query,
    issues: (data.items ?? [])
      .filter((i) => typeof i.number === "number" && typeof i.title === "string" && typeof i.html_url === "string")
      .map((i) => ({ number: i.number as number, title: i.title as string, url: i.html_url as string })),
  };
  searchCache.set(query, { at: Date.now(), result });
  if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value!);
  return result;
}
