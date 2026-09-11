/**
 * `file:` URI conversion, shared because both sides need it: the server hands
 * document URIs to language servers, and the browser turns a URI a server
 * returned (a definition, a diagnostic, a reference) back into a path it can
 * open a tab for.
 *
 * The encoding deliberately matches what VS Code puts on the wire, because
 * that is what every language server has been tested against:
 *
 *   /home/ada/a b/c.ts   ->  file:///home/ada/a%20b/c.ts
 *   C:\Users\ada\b.ts    ->  file:///c%3A/Users/ada/b.ts
 *
 * Two details that look like details and are not:
 *
 * - The Windows drive letter is lower-cased. The same file reached as `C:\` and
 *   `c:\` must produce one URI, or a diagnostic published for one spelling never
 *   clears the markers set under the other.
 * - `/` is not escaped but everything else in a segment is, so a `#` or `?` in a
 *   filename cannot truncate the URI into a fragment or a query.
 */

/** True for a Windows-style absolute path such as `C:\x` or `C:/x`. */
function isWindowsAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

export function pathToFileUri(path: string): string {
  const withSlashes = path.replace(/\\/g, "/");

  if (isWindowsAbsolute(withSlashes)) {
    const drive = withSlashes[0]!.toLowerCase();
    const rest = withSlashes.slice(2); // drop "C:"
    return `file:///${drive}%3A${encodePath(rest)}`;
  }

  // A UNC path (\\server\share) becomes an authority.
  if (withSlashes.startsWith("//")) {
    const [, , authority = "", ...segments] = withSlashes.split("/");
    return `file://${encodeURIComponent(authority)}${encodePath(`/${segments.join("/")}`)}`;
  }

  return `file://${encodePath(withSlashes)}`;
}

/** Percent-encode each segment, leaving the separators alone. */
function encodePath(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

/**
 * Turn a `file:` URI back into an OS path. Returns null for any other scheme —
 * servers legitimately emit `untitled:` and their own custom schemes, and
 * treating one of those as a path would open a tab for a file that never
 * existed.
 */
export function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith("file:")) return null;

  // file:///x, file://host/x, and the malformed-but-common file:/x.
  let rest = uri.slice("file:".length);
  let authority = "";
  if (rest.startsWith("//")) {
    rest = rest.slice(2);
    const slash = rest.indexOf("/");
    authority = slash < 0 ? rest : rest.slice(0, slash);
    rest = slash < 0 ? "" : rest.slice(slash);
  }

  const decoded = rest.split("/").map(decodeSegment).join("/");

  // A drive letter arrives as "/c:/Users/..." and has to lose the leading slash.
  if (/^\/[A-Za-z]:/.test(decoded)) {
    return decoded.slice(1);
  }
  if (authority) {
    return `//${decodeSegment(authority)}${decoded}`;
  }
  return decoded;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A stray "%" that is not an escape — keep the segment verbatim rather than
    // losing the whole path.
    return segment;
  }
}

/**
 * A comparison key for two URIs that name the same file.
 *
 * Servers do not always echo a URI back byte for byte: casing of an escape
 * (`%3a` vs `%3A`), an unescaped colon, or a Windows drive in the other case
 * all appear in practice. Diagnostics are keyed by URI, so two spellings of one
 * file means markers that are set twice and cleared never.
 */
export function uriKey(uri: string): string {
  const path = fileUriToPath(uri);
  if (path === null) return uri;
  const normalized = path.replace(/\\/g, "/");
  return isWindowsAbsolute(normalized)
    // Windows paths are case-insensitive; POSIX paths are not, so only the
    // drive letter is folded.
    ? `${normalized[0]!.toLowerCase()}${normalized.slice(1)}`
    : normalized;
}
