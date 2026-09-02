/**
 * Extension → icon component, using the Symbols set (the VS Code icon theme by Miguel
 * Solorio) so an explorer window reads like a real file manager.
 *
 * Imports come from the `/files` and `/folders` subpaths only. The root barrel pulls the
 * whole library (900+ icons) into the graph, and `/utils` drags in a lookup table that
 * defeats tree-shaking; naming each icon explicitly keeps the built chunk to the ~45
 * glyphs actually referenced here.
 *
 * The map is deliberately curated rather than exhaustive: rare extensions fall back to a
 * neutral glyph, which costs nothing and keeps the chunk inside its size budget.
 */

import type { FC, ComponentProps } from "react";
import {
  Astro, Audio, BracketsYellow, CLang, CodeBlue, CodeOrange, Cplus, Csharp, Csv, Dart,
  Database, Docker, Document, Exe, Font, Gear, Gif, Git, Go, Image, Java, Js, Kotlin,
  License, Lock, Lua, Markdown, Notebook, PDF, PHP, Python, Reactjs, Reactts, Ruby,
  Rust, Sass, Shell, SVG, Svelte, Swift, Text, TypeScript, Video, Vue, XML, Yaml, Zip,
} from "@react-symbols/icons/files";
import { Folder, FolderOpen } from "@react-symbols/icons/folders";

export type SymbolIcon = FC<ComponentProps<"svg">>;

export const FOLDER_ICON: SymbolIcon = Folder;
export const FOLDER_OPEN_ICON: SymbolIcon = FolderOpen;

/** One entry per icon; the key list is the set of extensions that share that glyph. */
const GROUPS: [SymbolIcon, string[]][] = [
  [TypeScript, ["ts", "mts", "cts"]],
  [Reactts, ["tsx"]],
  [Js, ["js", "mjs", "cjs"]],
  [Reactjs, ["jsx"]],
  [Vue, ["vue"]],
  [Svelte, ["svelte"]],
  [Astro, ["astro"]],
  [BracketsYellow, ["json", "jsonc", "json5"]],
  [Markdown, ["md", "mdx"]],
  [CodeOrange, ["html", "htm"]],
  [CodeBlue, ["css"]],
  [Sass, ["scss", "sass", "less"]],
  [Yaml, ["yaml", "yml"]],
  [XML, ["xml", "plist"]],
  [Gear, ["toml", "ini", "cfg", "conf", "env", "properties"]],
  [Python, ["py", "pyi"]],
  [Ruby, ["rb"]],
  [Go, ["go"]],
  [Rust, ["rs"]],
  [Java, ["java", "jar"]],
  [Kotlin, ["kt", "kts"]],
  [Swift, ["swift"]],
  [CLang, ["c", "h"]],
  [Cplus, ["cpp", "cc", "cxx", "hpp"]],
  [Csharp, ["cs"]],
  [PHP, ["php"]],
  [Lua, ["lua"]],
  [Dart, ["dart"]],
  [Shell, ["sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd"]],
  [Database, ["sql", "db", "sqlite", "sqlite3"]],
  [Csv, ["csv", "tsv"]],
  [PDF, ["pdf"]],
  [Document, ["doc", "docx", "rtf", "odt", "pages"]],
  [Notebook, ["ipynb"]],
  [Text, ["txt", "log", "text"]],
  [Image, ["png", "jpg", "jpeg", "webp", "bmp", "ico", "tif", "tiff", "avif"]],
  [Gif, ["gif"]],
  [SVG, ["svg"]],
  [Video, ["mp4", "webm", "mov", "avi", "mkv", "m4v"]],
  [Audio, ["mp3", "wav", "flac", "aac", "m4a", "ogg", "wma"]],
  [Zip, ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz"]],
  [Exe, ["exe", "msi", "dmg", "appimage", "deb", "rpm"]],
  [Font, ["ttf", "otf", "woff", "woff2", "eot"]],
  [Lock, ["lock"]],
];

const BY_EXTENSION = new Map<string, SymbolIcon>();
for (const [icon, extensions] of GROUPS) {
  for (const ext of extensions) BY_EXTENSION.set(ext, icon);
}

/** Whole-name matches, for files whose type lives in the name rather than an extension. */
const BY_FILENAME = new Map<string, SymbolIcon>([
  [".gitignore", Git],
  [".gitattributes", Git],
  [".gitmodules", Git],
  ["dockerfile", Docker],
  [".dockerignore", Docker],
  ["license", License],
  ["licence", License],
  ["makefile", Gear],
  [".editorconfig", Gear],
  [".npmrc", Gear],
  [".env", Gear],
]);

/** Icon for a file name, or `null` when nothing in the curated set matches. */
export function fileIconFor(name: string): SymbolIcon | null {
  const base = (name.split(/[/\\]/).pop() ?? name).toLowerCase();
  const byName = BY_FILENAME.get(base);
  if (byName) return byName;
  // Compound extensions ("archive.tar.gz") resolve on the last segment, which is right
  // for every entry above.
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXTENSION.get(base.slice(dot + 1)) ?? null;
}
