import { createContext, useContext } from "react";
import { defaultUrlTransform } from "react-markdown";
import { splitSourceLocation, type SourceLine } from "@/lib/source-location";

/** Common text file extensions that PPM can open as editor tabs */
const FILE_EXTS = "ts|tsx|js|jsx|mjs|cjs|py|json|md|mdx|yaml|yml|toml|css|scss|less|html|htm|sh|bash|zsh|go|rs|sql|rb|java|kt|swift|c|cpp|h|hpp|cs|vue|svelte|txt|env|cfg|conf|ini|xml|csv|log|dockerfile|makefile|gradle|output";
export const FILE_EXT_RE = new RegExp(`\\.(${FILE_EXTS})$`, "i");
/** Glob/regex chars that indicate a pattern, not a real file */
export const GLOB_CHARS_RE = /[*?{}\[\]]/;
/** Detect local absolute file paths (Unix or Windows) */
export const LOCAL_PATH_RE = /^(\/|[A-Za-z]:[/\\])/;

/** Preserve local destinations; keep react-markdown's safety filter for other schemes. */
export function markdownUrlTransform(url: string): string {
  return LOCAL_PATH_RE.test(url) || parseMarkdownFileTarget(url) ? url : defaultUrlTransform(url);
}

/** Parse local links independently of file extensions; the host determines file vs folder. */
export function parseMarkdownFileTarget(href: string) {
  if (!href || href.startsWith("#") || /[?*\u0000-\u001f]/.test(href)) return null;
  let destination = href;
  if (/^file:/i.test(destination)) {
    const local = destination.match(/^file:\/\/(?:localhost)?(\/.*)$/i);
    if (!local) return null; // Remote file authorities/UNC are unsupported by the host API.
    destination = local[1]!;
  }
  const located = splitSourceLocation(destination);
  if (!located) return null; // A suffix naming an impossible line is a broken reference, not line 1.
  // A document heading still opens the document; a pure anchor stays in the page.
  let path = located.line ? located.path : located.path.split("#")[0]!;
  try { path = decodeURIComponent(path); } catch { return null; }
  // Check schemes after separating line numbers: config.ts:136 is a file reference.
  if (!path || /[\u0000-\u001f\u007f]/.test(path) || /^[\\/]{2}/.test(path)
    || (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[/\\]/i.test(path))) return null;
  // Codex prefixes Windows drive paths with a slash in Markdown destinations.
  path = path.replace(/^\/([a-z]:[/\\])/i, "$1");
  return { path, line: located.line };
}

export interface MdContextValue {
  projectName?: string;
  codeActions: boolean;
  /** True while the message is still streaming — defer async Shiki highlight until done. */
  isStreaming: boolean;
  openFileOrSearch: (path: string, line?: SourceLine) => void;
  openImageOverlay: (url: string, alt: string, gallery?: { src: string; alt: string }[]) => void;
  openDiagramOverlay: (svg: string) => void;
}

export const MdContext = createContext<MdContextValue>(null!);
export const useMdContext = () => useContext(MdContext);
