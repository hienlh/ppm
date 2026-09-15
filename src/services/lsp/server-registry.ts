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
 * Bounded by the project root on purpose: walking past it would find a
 * `tsconfig.json` in the user's home directory and root a server there, which
 * makes it index everything they own.
 */
export function ancestorDirs(filePath: string, projectPath: string, platform: NodeJS.Platform = process.platform): string[] {
  const p = platform === "win32" ? path.win32 : path.posix;
  const root = p.normalize(projectPath).replace(/[\\/]+$/, "");
  let dir = p.dirname(p.normalize(filePath));

  const dirs: string[] = [];
  for (;;) {
    dirs.push(dir);
    if (dir === root || dir.length <= root.length) break;
    const parent = p.dirname(dir);
    if (parent === dir) break; // hit the filesystem root
    dir = parent;
  }
  // A file outside the project root yields only its own directory chain up to
  // the point the loop stopped; keep the root itself reachable either way.
  if (!dirs.includes(root)) dirs.push(root);
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
