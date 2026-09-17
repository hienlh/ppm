import { createContext, useContext } from "react";
import { defaultUrlTransform } from "react-markdown";

/** Common text file extensions that PPM can open as editor tabs */
const FILE_EXTS = "ts|tsx|js|jsx|mjs|cjs|py|json|md|mdx|yaml|yml|toml|css|scss|less|html|htm|sh|bash|zsh|go|rs|sql|rb|java|kt|swift|c|cpp|h|hpp|cs|vue|svelte|txt|env|cfg|conf|ini|xml|csv|log|dockerfile|makefile|gradle|output";
export const FILE_EXT_RE = new RegExp(`\\.(${FILE_EXTS})$`, "i");
/** Glob/regex chars that indicate a pattern, not a real file */
export const GLOB_CHARS_RE = /[*?{}\[\]]/;
/** Detect local absolute file paths (Unix or Windows) */
export const LOCAL_PATH_RE = /^(\/|[A-Za-z]:[/\\])/;

/** Keep Windows absolute file links intact; defer all other URL safety filtering to react-markdown. */
export function markdownUrlTransform(url: string): string {
  return LOCAL_PATH_RE.test(url) ? url : defaultUrlTransform(url);
}

export interface MdContextValue {
  projectName?: string;
  codeActions: boolean;
  /** True while the message is still streaming — defer async Shiki highlight until done. */
  isStreaming: boolean;
  openFileOrSearch: (path: string, line?: { start: number; end?: number }) => void;
  openImageOverlay: (url: string, alt: string, gallery?: { src: string; alt: string }[]) => void;
  openDiagramOverlay: (svg: string) => void;
}

export const MdContext = createContext<MdContextValue>(null!);
export const useMdContext = () => useContext(MdContext);
