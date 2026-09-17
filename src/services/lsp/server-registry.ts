/**
 * Which language server serves which file, how to find it, and what to tell
 * the user when it is missing.
 *
 * Nothing here spawns or touches the filesystem — it answers "what would you
 * run" so the decisions are testable on their own. `lsp-manager.ts` does the
 * looking and the launching.
 *
 * The language ids are LSP's, which are VS Code's, and they are deliberately
 * *not* PPM's Monaco ids. Monaco maps `.tsx` to `typescript`; LSP calls it
 * `typescriptreact`, and the distinction is load-bearing rather than cosmetic —
 * tsserver decides whether to parse JSX from the language id, so a `.tsx` file
 * announced as `typescript` gets a syntax error on its first tag.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export interface LanguageServerDefinition {
  /** Stable id, used in status reporting and as the marker owner. */
  id: string;
  displayName: string;
  /** LSP language ids this server handles. */
  languages: string[];
  command: string;
  args: string[];
  /**
   * Files that mark the root of a project this server understands. The nearest
   * ancestor holding one becomes the rootUri, so a monorepo package gets its
   * own server rather than one rooted at the repository top.
   */
  rootMarkers: string[];
  /** Shown verbatim when the command cannot be found. */
  installHint: string;
  /**
   * The npm package PPM depends on for this server, when it ships one.
   *
   * Only set where the package is in PPM's own `dependencies` — naming one that is not there
   * makes `bundledServerEntry` answer with a path nothing ever wrote.
   */
  bundledPackage?: string;
  initializationOptions?: Record<string, unknown>;
}

/**
 * File extension to LSP language id.
 *
 * Extensionless names that are whole filenames (Dockerfile, Makefile) are
 * matched separately, in `lspLanguageForPath`.
 */
const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "javascriptreact",
  py: "python", pyi: "python",
  go: "go",
  rs: "rust",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
  json: "json",
  jsonc: "jsonc",
  html: "html", htm: "html",
  css: "css", scss: "scss", less: "less",
  yaml: "yaml", yml: "yaml",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript",
  php: "php",
  rb: "ruby",
  lua: "lua",
  vue: "vue",
  svelte: "svelte",
};

const FILENAME_LANGUAGE: Record<string, string> = {
  dockerfile: "dockerfile",
  "tsconfig.json": "jsonc",
  "jsconfig.json": "jsonc",
  ".eslintrc.json": "jsonc",
};

/** The LSP language id for a path, or null when no server could serve it. */
export function lspLanguageForPath(filePath: string): string | null {
  const base = filePath.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  const byName = FILENAME_LANGUAGE[base];
  if (byName) return byName;

  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null; // no extension, or a dotfile with no suffix
  return EXTENSION_LANGUAGE[base.slice(dot + 1)] ?? null;
}

/**
 * The servers PPM knows how to drive.
 *
 * The first entry that is actually installed wins, so ordering within a
 * language matters. TypeScript comes from `typescript-language-server`, which
 * wraps the same tsserver VS Code drives — the intelligence is identical, only
 * the transport differs.
 */
export const LANGUAGE_SERVERS: LanguageServerDefinition[] = [
  {
    id: "typescript",
    displayName: "TypeScript",
    languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    command: "typescript-language-server",
    args: ["--stdio"],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
    // `typescript@5` is pinned deliberately. The 7.x line is the native port
    // and ships no `tsserver.js`, so typescript-language-server refuses to
    // start against it with "provides no tsserver" — which reads like a broken
    // install rather than the wrong major version.
    installHint: "bun add -g typescript-language-server typescript@5",
    // Shipped with PPM, so this one works on a fresh install with nothing else done. The
    // project's own copy still wins where there is one — a repository pinned to TypeScript 4
    // has to be analysed by its own server, not by whatever PPM happens to carry.
    bundledPackage: "typescript-language-server",
    initializationOptions: {
      // Matches what VS Code asks tsserver for: completions that can add an
      // import, and snippet text so a function completion fills its parens.
      preferences: {
        includeCompletionsForModuleExports: true,
        includeCompletionsWithSnippetText: true,
        includeCompletionsWithInsertText: true,
        importModuleSpecifierPreference: "shortest",
        // Inlay hints are opt-in *per kind* on the server side, and tsserver
        // returns an empty array for every one that is off. Without these the
        // editor asks, the server answers "no hints", and a feature that is
        // switched on in Monaco shows nothing at all — measured as 0 hints for
        // a 2233-line file.
        //
        // Parameter names only. Those are the ones worth reading — they say
        // what a bare `true` or a positional array index means at a call site.
        // The type hints (variable, property, return) are the noisy ones: they
        // restate what the code already says on most lines, and VS Code ships
        // all of them off.
        includeInlayParameterNameHints: "all",
        // `foo(name)` for `foo(name: string)` is the one hint that never adds
        // anything, so it is suppressed the way VS Code suppresses it.
        includeInlayParameterNameHintsWhenArgumentMatchesName: false,
        includeInlayEnumMemberValueHints: true,
        includeInlayFunctionLikeReturnTypeHints: false,
        includeInlayFunctionParameterTypeHints: false,
        includeInlayVariableTypeHints: false,
        includeInlayPropertyDeclarationTypeHints: false,
      },
    },
  },
  {
    id: "pyright",
    displayName: "Pyright",
    languages: ["python"],
    command: "pyright-langserver",
    args: ["--stdio"],
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
    installHint: "bun add -g pyright",
  },
  {
    id: "gopls",
    displayName: "gopls",
    languages: ["go"],
    command: "gopls",
    args: [],
    rootMarkers: ["go.work", "go.mod"],
    installHint: "go install golang.org/x/tools/gopls@latest",
  },
  {
    id: "rust-analyzer",
    displayName: "rust-analyzer",
    languages: ["rust"],
    command: "rust-analyzer",
    args: [],
    rootMarkers: ["Cargo.toml"],
    installHint: "rustup component add rust-analyzer",
  },
  {
    id: "clangd",
    displayName: "clangd",
    languages: ["c", "cpp"],
    command: "clangd",
    args: ["--background-index"],
    rootMarkers: ["compile_commands.json", "compile_flags.txt", ".clangd", "CMakeLists.txt", "Makefile"],
    installHint: "install clangd from your package manager (pacman -S clang, apt install clangd)",
  },
  {
    id: "json",
    displayName: "JSON",
    languages: ["json", "jsonc"],
    command: "vscode-json-language-server",
    args: ["--stdio"],
    rootMarkers: ["package.json"],
    installHint: "bun add -g vscode-langservers-extracted",
  },
  {
    id: "html",
    displayName: "HTML",
    languages: ["html"],
    command: "vscode-html-language-server",
    args: ["--stdio"],
    rootMarkers: ["package.json"],
    installHint: "bun add -g vscode-langservers-extracted",
  },
  {
    id: "css",
    displayName: "CSS",
    languages: ["css", "scss", "less"],
    command: "vscode-css-language-server",
    args: ["--stdio"],
    rootMarkers: ["package.json"],
    installHint: "bun add -g vscode-langservers-extracted",
  },
  {
    id: "yaml",
    displayName: "YAML",
    languages: ["yaml"],
    command: "yaml-language-server",
    args: ["--stdio"],
    rootMarkers: [],
    installHint: "bun add -g yaml-language-server",
  },
  {
    id: "bash",
    displayName: "Bash",
    languages: ["shellscript"],
    command: "bash-language-server",
    args: ["start"],
    rootMarkers: [],
    installHint: "bun add -g bash-language-server",
  },
  {
    id: "intelephense",
    displayName: "Intelephense",
    languages: ["php"],
    command: "intelephense",
    args: ["--stdio"],
    rootMarkers: ["composer.json"],
    installHint: "bun add -g intelephense",
  },
  {
    id: "solargraph",
    displayName: "Solargraph",
    languages: ["ruby"],
    command: "solargraph",
    args: ["stdio"],
    rootMarkers: ["Gemfile", ".solargraph.yml"],
    installHint: "gem install solargraph",
  },
  {
    id: "lua",
    displayName: "Lua",
    languages: ["lua"],
    command: "lua-language-server",
    args: [],
    rootMarkers: [".luarc.json"],
    installHint: "install lua-language-server from your package manager",
  },
  {
    id: "vue",
    displayName: "Vue",
    languages: ["vue"],
    command: "vue-language-server",
    args: ["--stdio"],
    rootMarkers: ["package.json"],
    installHint: "bun add -g @vue/language-server",
  },
  {
    id: "svelte",
    displayName: "Svelte",
    languages: ["svelte"],
    command: "svelteserver",
    args: ["--stdio"],
    rootMarkers: ["package.json"],
    installHint: "bun add -g svelte-language-server",
  },
];

/** Every server that claims this language, in preference order. */
export function serversForLanguage(languageId: string): LanguageServerDefinition[] {
  return LANGUAGE_SERVERS.filter((s) => s.languages.includes(languageId));
}

export function serverById(id: string): LanguageServerDefinition | undefined {
  return LANGUAGE_SERVERS.find((s) => s.id === id);
}

/**
 * Directories to search, nearest first, from the file's own directory up to and
 * including the project root.
 *
 * Every directory here is both searched for `node_modules/.bin/<server>` — which
 * is then *executed* — and searched for a root marker that would become a
 * server's rootUri. So the bound is the whole trust story: without it a file at
 * `~/notes/x.ts` puts `~/node_modules/.bin` on the list and roots a server at
 * the user's home directory, indexing everything they own.
 *
 * The bound is enforced rather than assumed. The walk used to stop by comparing
 * *lengths*, which happens to hold for a file inside the project and not at all
 * for one outside it: `/home/ada/repo-other/deep/x.ts` against a project at
 * `/home/ada/repo` yielded three `repo-other` directories and `/home/ada`. The
 * bridge confines the path before this is reached, so nothing could reach it —
 * but a guard whose comment claims more than its code does is one caller away
 * from being a real hole.
 */
export function ancestorDirs(filePath: string, projectPath: string, platform: NodeJS.Platform = process.platform): string[] {
  const p = platform === "win32" ? path.win32 : path.posix;
  const root = p.normalize(projectPath).replace(/[\\/]+$/, "");
  const start = p.dirname(p.normalize(filePath));
  // Windows paths are case-insensitive, so `C:\Users\Ada\Repo` and `c:\users\ada\repo` name
  // one directory. Comparing them case-sensitively refuses the project outright — and, once
  // the walk can no longer recognise its own root, lets it climb straight past it to `C:\`.
  const fold = (dir: string) => (platform === "win32" ? dir.toLowerCase() : dir);
  const foldedRoot = fold(root);
  const inside = (dir: string) => fold(dir) === foldedRoot || fold(dir).startsWith(foldedRoot + p.sep);
  if (!inside(start)) return [root];

  const dirs: string[] = [];
  for (let dir = start; ; ) {
    dirs.push(dir);
    if (fold(dir) === foldedRoot) return dirs;
    const parent = p.dirname(dir);
    if (parent === dir) break; // hit the filesystem root
    dir = parent;
  }
  dirs.push(root);
  return dirs;
}

/**
 * Absolute paths to try for a server command, in order, ending with the bare
 * command for PATH lookup.
 *
 * A project's own `node_modules/.bin` comes first so a repository that pins its
 * language server gets that version — the same reason VS Code offers "Use
 * Workspace Version" for TypeScript. Getting this backwards means a project
 * pinned to TypeScript 4 is analysed by whatever is installed globally.
 *
 * That does mean opening a file runs a binary the repository supplied, so it is
 * worth being explicit about what bounds it. Registering a project in PPM
 * already hands that directory a terminal and an agent running in
 * `bypassPermissions`; a `postinstall` script has run long before any of this.
 * The setting is off by default and per device, so a language server exists only
 * where someone asked for one. And `dirs` comes from `ancestorDirs`, which
 * answers with directories inside the project and nothing else — that is the
 * part that had to be enforced rather than assumed, and it is where the
 * confinement actually lives.
 */
export function candidateCommandPaths(command: string, dirs: string[], platform: NodeJS.Platform = process.platform): string[] {
  const p = platform === "win32" ? path.win32 : path.posix;
  // npm/bun write a .cmd shim on Windows; the extensionless file there is a
  // shell script Windows cannot execute.
  const names = platform === "win32" ? [`${command}.cmd`, `${command}.exe`, command] : [command];

  const candidates: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      candidates.push(p.join(dir, "node_modules", ".bin", name));
    }
  }
  candidates.push(command);
  return candidates;
}

/**
 * The copy PPM ships itself, for servers listed in its own dependencies.
 *
 * The floor under the other two lookups, and the reason the TypeScript server works on a
 * fresh install with nothing else done: PPM depends on `typescript-language-server`, so npm
 * puts it in PPM's *own* `node_modules` — which is neither the project's nor on `PATH`, so
 * without this it was installed and unreachable.
 *
 * This answers with the package's **entry script**, not npm's `.bin` shim, and that is the
 * load-bearing part. The shim starts `#!/usr/bin/env node`; PPM runs on Bun, and someone who
 * installed it with `bun install -g ppm` may have no `node` on the machine at all. Measured:
 * spawning the shim with nothing named `node` on `PATH` exits **127** with `env: 'node': No
 * such file or directory` — after the server had already been reported as installed. The
 * caller runs this with `process.execPath` instead. It also retires the `.cmd`/`.exe` guessing
 * on Windows, since the entry is the same `.mjs` file on every platform.
 *
 * Resolved through the package rather than built from `import.meta.dir`: PPM runs from a
 * global install, from a checkout, and from a bundled binary, and only the resolver knows
 * where its dependencies actually landed in each. `null` when the package is absent, which is
 * every server PPM does not bundle.
 */
export function bundledServerEntry(
  definition: LanguageServerDefinition,
  resolve: (specifier: string) => string = createRequire(import.meta.url).resolve,
): string | null {
  const pkg = definition.bundledPackage;
  if (!pkg) return null;
  let manifestPath: string;
  let manifest: { bin?: string | Record<string, string> };
  try {
    manifestPath = resolve(`${pkg}/package.json`);
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest;
  } catch {
    return null;
  }
  // `bin` is either a bare string — the package's own name — or a map of command to path.
  const relative = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[definition.command];
  if (!relative) return null;
  return path.resolve(path.dirname(manifestPath), relative);
}
