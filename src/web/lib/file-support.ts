/**
 * Claude Code supported file types for chat attachments.
 * Supported files are uploaded and referenced; unsupported files get path inserted as text.
 */

/** Image MIME types Claude Code can read via the Read tool (multimodal) */
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Document MIME types Claude Code can read */
const SUPPORTED_DOC_TYPES = new Set([
  "application/pdf",
]);

/** Text/code MIME prefixes Claude Code can read */
const TEXT_MIME_PREFIXES = [
  "text/",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-yaml",
  "application/toml",
  "application/x-sh",
];

/** File extensions considered text/code even if MIME is application/octet-stream */
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".cpp", ".h", ".hpp", ".cs",
  ".json", ".yaml", ".yml", ".toml", ".xml",
  ".md", ".mdx", ".txt", ".csv", ".tsv",
  ".html", ".css", ".scss", ".less", ".sass",
  ".sh", ".bash", ".zsh", ".fish",
  ".sql", ".graphql", ".gql",
  ".env", ".ini", ".cfg", ".conf",
  ".dockerfile", ".makefile",
  ".vue", ".svelte", ".astro",
  ".ipynb",
]);

export function isImageFile(file: File): boolean {
  return SUPPORTED_IMAGE_TYPES.has(file.type);
}

export function isSupportedFile(file: File): boolean {
  // Images
  if (SUPPORTED_IMAGE_TYPES.has(file.type)) return true;
  // Documents
  if (SUPPORTED_DOC_TYPES.has(file.type)) return true;
  // Text MIME types
  if (TEXT_MIME_PREFIXES.some((p) => file.type.startsWith(p))) return true;
  // Fallback: check extension
  const ext = getExtension(file.name);
  if (ext && TEXT_EXTENSIONS.has(ext)) return true;
  return false;
}

function getExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return "";
  return name.slice(dot).toLowerCase();
}
