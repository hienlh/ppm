/**
 * Which files PPM can display, and in which viewer.
 *
 * The editor tab picks its renderer from the file extension. Keeping those sets here
 * (rather than inside the editor component) lets the explorer answer "will a double-click
 * do anything?" before it opens a tab, and guarantees the two never drift apart: the
 * editor imports the very same sets.
 */

/** Image extensions renderable inline */
export const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"]);
/** Video extensions playable inline */
export const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "ogg", "avi", "mkv"]);
/** Audio extensions playable inline */
export const AUDIO_EXTS = new Set(["mp3", "wav", "flac", "aac", "m4a", "wma"]);
/** SQLite extensions — redirect to sqlite viewer */
export const SQLITE_EXTS = new Set(["db", "sqlite", "sqlite3"]);
/** Rendered as formatted markdown (with a raw edit mode) */
export const MARKDOWN_EXTS = new Set(["md", "mdx"]);

/**
 * Extensions Monaco opens as editable text. Anything outside this list is assumed
 * binary: the server would answer with a base64 body and the editor would only be able
 * to say "cannot be displayed", so the explorer treats it as not openable instead.
 */
export const TEXT_EXTS = new Set([
  "txt", "log", "ini", "cfg", "conf", "env", "properties", "editorconfig",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts",
  "json", "jsonc", "json5", "yaml", "yml", "toml", "xml", "svg",
  "html", "htm", "css", "scss", "sass", "less", "vue", "svelte", "astro",
  "py", "rb", "php", "go", "rs", "java", "kt", "kts", "swift", "c", "h",
  "cpp", "cc", "hpp", "cs", "m", "mm", "scala", "lua", "dart", "r", "pl",
  "sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd",
  "sql", "graphql", "gql", "proto", "prisma", "tf", "tfvars",
  "dockerfile", "makefile", "gitignore", "gitattributes", "npmrc", "nvmrc",
  "diff", "patch", "lock", "map", "srt", "vtt",
]);

/**
 * Extensionless files that are conventionally plain text. Matched on the whole
 * (lower-cased) name so `Dockerfile`, `LICENSE` and friends open in the editor.
 */
export const TEXT_FILENAMES = new Set([
  "dockerfile", "makefile", "license", "licence", "readme", "changelog",
  "authors", "contributing", "notice", "codeowners", "procfile", "brewfile",
  "gemfile", "rakefile", "vagrantfile", "justfile",
]);

/** Which viewer an editor tab will render for this file. */
export type ViewerKind =
  | "image" | "video" | "audio" | "pdf" | "docx"
  | "sqlite" | "markdown" | "csv" | "text";

/** Lower-cased extension without the dot; empty string when there is none. */
export function extensionOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  // A leading dot is part of the name (".gitignore"), not an extension separator.
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** The viewer PPM would use for this file, or `null` when it cannot show it. */
export function viewerKindOf(name: string): ViewerKind | null {
  const base = (name.split(/[/\\]/).pop() ?? name).toLowerCase();
  const ext = extensionOf(base);

  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (SQLITE_EXTS.has(ext)) return "sqlite";
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  if (ext === "csv") return "csv";
  if (TEXT_EXTS.has(ext)) return "text";
  // Dotfiles ('.gitignore') and extensionless names ('Dockerfile') carry their
  // type in the name itself.
  if (!ext) {
    const stem = base.startsWith(".") ? base.slice(1) : base;
    if (TEXT_FILENAMES.has(stem) || TEXT_EXTS.has(stem)) return "text";
  }
  return null;
}

/** True when double-clicking the file should open a PPM tab. */
export function canOpenInPpm(name: string): boolean {
  return viewerKindOf(name) !== null;
}
