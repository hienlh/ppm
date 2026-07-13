/** Fetch + parse release notes (CHANGELOG.md) between the installed and latest version. */

const CHANGELOG_URL = "https://raw.githubusercontent.com/hienlh/ppm/main/CHANGELOG.md";

export interface ChangelogSection {
  version: string;
  date: string;
  /** Markdown body of the section (between this heading and the next). */
  body: string;
}

/** Compare two `x.y.z` versions: >0 if a>b, <0 if a<b, 0 if equal. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const HEADING_RE = /^##\s*\[(\d+\.\d+\.\d+)\]\s*(?:-\s*(.+))?\s*$/;

/** Parse CHANGELOG markdown into all version sections (newest first, as authored). */
export function parseChangelog(md: string): ChangelogSection[] {
  const lines = md.split(/\r?\n/);
  const sections: ChangelogSection[] = [];
  let current: ChangelogSection | null = null;
  const bodyLines: string[] = [];

  const flush = () => {
    if (current) {
      current.body = bodyLines.join("\n").trim();
      sections.push(current);
    }
    bodyLines.length = 0;
  };

  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (m) {
      flush();
      current = { version: m[1]!, date: (m[2] ?? "").trim(), body: "" };
    } else if (current) {
      bodyLines.push(line);
    }
  }
  flush();

  return sections;
}

/** Parse CHANGELOG markdown into version sections strictly newer than `since`. */
export function parseChangelogSince(md: string, since: string): ChangelogSection[] {
  return parseChangelog(md).filter((s) => compareSemver(s.version, since) > 0);
}

/**
 * Fetch the published CHANGELOG markdown.
 * A timestamp query busts GitHub's raw CDN cache (~5min TTL) — otherwise the
 * changelog can lag the npm-registry version signal right after a release,
 * so the newest section(s) go missing from the upgrade popover.
 */
async function fetchChangelogMd(): Promise<string> {
  const res = await fetch(`${CHANGELOG_URL}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`CHANGELOG fetch failed (${res.status})`);
  return res.text();
}

/** Fetch the published CHANGELOG and return sections newer than the installed version. */
export async function fetchChangelogSince(since: string): Promise<ChangelogSection[]> {
  return parseChangelogSince(await fetchChangelogMd(), since);
}

/** Fetch the published CHANGELOG and return the most recent `limit` sections. */
export async function fetchRecentChangelog(limit = 10): Promise<ChangelogSection[]> {
  return parseChangelog(await fetchChangelogMd()).slice(0, limit);
}
