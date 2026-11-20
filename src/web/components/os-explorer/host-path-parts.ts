/**
 * Splitting a host path the browser was handed, for the few places that need its parent or a
 * comparison without asking the server (place labels, the path field's "file → its folder").
 * The host may be Windows while the browser is not, so the separator is read off the path itself
 * rather than the browser's platform. Everything else (breadcrumbs) comes from the server.
 */

export const isWindowsPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.includes("\\");
export const sepOf = (p: string) => (isWindowsPath(p) ? "\\" : "/");
/** Windows paths compare without case; POSIX ones exactly. */
export const samePath = (a: string, b: string) => (isWindowsPath(a) || isWindowsPath(b) ? a.toLowerCase() === b.toLowerCase() : a === b);

/** `p` without trailing separators, keeping a root (`/`, `C:\`) whole. */
export function trimEnd(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  if (!trimmed) return "/";
  return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}${sepOf(p)}` : trimmed;
}

/** The folder holding `p`, or null for a root. */
export function parentOf(p: string): string | null {
  const path = trimEnd(p);
  if (/^[A-Za-z]:[\\/]$/.test(path)) return null;
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (index < 0) return null;
  const parent = path.slice(0, index);
  if (!parent) return path === "/" ? null : "/";
  return /^[A-Za-z]:$/.test(parent) ? `${parent}${sepOf(path)}` : parent;
}
