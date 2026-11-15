/**
 * The ways people and AI name tasks and their links: `project/123` and `#123` for a task, a Jira
 * key, and a PR as `owner/repo#n` or its GitHub URL (stored canonically as `owner/repo#n`).
 */

export type ParsedTaskRef = { project: string | null; number: number };

const TASK_REF = /^(?:([A-Za-z0-9_.-]{1,100})\/)?#?(\d{1,9})$/;

/** `ppm/12`, `#12` or `12`; null for anything else. */
export function parseTaskRef(input: string): ParsedTaskRef | null {
  const m = TASK_REF.exec(input.trim());
  if (!m) return null;
  const number = Number(m[2]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { project: m[1] ?? null, number };
}

/** `ppm/12` with a project name, `#12` without. */
export function formatTaskRef(number: number, project?: string | null): string {
  return project ? `${project}/${number}` : `#${number}`;
}

const JIRA_KEY = /^[A-Z][A-Z0-9]{0,19}-\d{1,9}$/;

/** A Jira key such as `NX-6318`, upper-cased; null when it is not one. */
export function parseJiraKey(input: string): string | null {
  const key = input.trim().toUpperCase();
  return JIRA_KEY.test(key) ? key : null;
}

const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const REPO = "[A-Za-z0-9_.-]{1,100}";
const PR_SHORT = new RegExp(`^(${OWNER})/(${REPO})#(\\d{1,9})$`);
const PR_URL = new RegExp(`^https?://(?:www\\.)?github\\.com/(${OWNER})/(${REPO})/pull/(\\d{1,9})(?:[/?#].*)?$`, "i");

export interface PrRef { owner: string; repo: string; number: number }

/** `owner/repo#n` or a GitHub pull-request URL; null for anything else. */
export function parsePrRef(input: string): PrRef | null {
  const s = input.trim();
  const m = PR_SHORT.exec(s) ?? PR_URL.exec(s);
  if (!m) return null;
  const number = Number(m[3]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { owner: m[1]!, repo: m[2]!, number };
}

export function formatPrRef(pr: PrRef): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}

/** The canonical stored ref of a PR given either way; null when it is not a PR. */
export function canonicalPrRef(input: string): string | null {
  const pr = parsePrRef(input);
  return pr ? formatPrRef(pr) : null;
}
