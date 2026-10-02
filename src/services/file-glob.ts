/**
 * file-glob.ts
 * VS Code-style glob matching for file excludes. Kept free of any import that reaches the
 * config store or the database, because the file index worker runs it on its own thread.
 */

/**
 * Check if a relative path matches any of the given glob patterns.
 * Uses simple pattern-to-regex conversion (no external lib needed).
 * Patterns follow VS Code glob semantics: ** crosses dirs, * stays in one segment.
 */
export function matchesGlob(relPath: string, patterns: string[]): boolean {
  // Normalize path separators to forward slash
  const normalized = relPath.split("\\").join("/");
  return patterns.some((pattern) => matchSingleGlob(normalized, pattern));
}

function matchSingleGlob(relPath: string, pattern: string): boolean {
  // Strip leading **/ for simpler matching — handled by regex
  const re = globPatternToRegex(pattern);
  return re.test(relPath);
}

/**
 * Convert a VS Code-style glob pattern to a RegExp.
 * Cached per unique pattern string for performance.
 */
const regexCache = new Map<string, RegExp>();

function globPatternToRegex(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) return cached;

  let p = pattern;
  // Normalize path separators
  p = p.split("\\").join("/");
  // Strip leading ./
  if (p.startsWith("./")) p = p.slice(2);

  // Leading `**/` should match zero-or-more path segments, INCLUDING root.
  // So `**/.git` matches both `.git` (at root) and `src/.git` (nested).
  // Strip `**/` prefix here so it doesn't force a leading path; we handle it via optional group below.
  const hasStarstarPrefix = p.startsWith("**/");
  if (hasStarstarPrefix) p = p.slice(3);

  const escaped = p
    .replace(/[.+^${}()|[\]]/g, "\\$&") // escape regex special chars (not * ?)
    .replace(/\*\*/g, "\x00")            // temp: ** placeholder
    .replace(/\*/g, "[^/]*")             // * = within one path segment
    .replace(/\x00/g, ".*")             // ** = any path
    .replace(/\?/g, "[^/]");            // ? = single non-slash char

  let re: RegExp;
  if (hasStarstarPrefix) {
    // `**/X` → match X at any depth including root: `(^|.*/)X(/|$)`
    re = new RegExp(`(^|.*/)${escaped}(/|$)`);
  } else if (p.includes("/")) {
    // Anchored pattern with explicit path
    re = new RegExp(`^${escaped}(/|$)`);
  } else {
    // Pattern with no slash (e.g. *.log) → match at any depth
    re = new RegExp(`(^|/)${escaped}(/|$)`);
  }

  regexCache.set(pattern, re);
  return re;
}
