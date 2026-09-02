/** Presentation helpers for file metadata, shared by the explorer views, the
 *  properties dialog and the directory picker. */

/** Human-readable byte count. Undefined size renders as an empty cell. */
export function formatSize(bytes?: number): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Coarse "how long ago" label; good enough for a list column. */
export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** Absolute local timestamp for the properties dialog. Invalid dates render blank. */
export function formatDateTime(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

/**
 * POSIX permission bits as the familiar three-digit octal. Windows does not encode
 * write permission in the mode, so callers show the read-only flag there instead.
 */
export function formatMode(mode?: number): string {
  if (mode == null) return "";
  return (mode & 0o777).toString(8).padStart(3, "0");
}

/** Directory name of an absolute path, using the host separator. Root maps to itself. */
export function dirnameOf(path: string, sep: string): string {
  const trimmed = path.endsWith(sep) && path.length > sep.length ? path.slice(0, -sep.length) : path;
  const idx = trimmed.lastIndexOf(sep);
  if (idx < 0) return trimmed;
  if (idx === 0) return sep; // POSIX root
  const head = trimmed.slice(0, idx);
  // "C:" alone is not browsable — a Windows drive root needs its trailing separator.
  return head.endsWith(":") ? head + sep : head;
}

/** Join a directory and a child name with the host separator. */
export function joinPath(dir: string, name: string, sep: string): string {
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** Insert a " (2)" style suffix before the extension, for "Keep both" pastes. */
export function suffixName(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name} (${n})`;
  return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}
