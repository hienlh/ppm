import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { sep } from "node:path";
import {
  LANGUAGE_SERVERS,
  ancestorDirs,
  bundledServerEntry,
  candidateCommandPaths,
  lspLanguageForPath,
  serverById,
  serversForLanguage,
} from "../../../../src/services/lsp/server-registry.ts";

describe("lspLanguageForPath", () => {
  it("distinguishes the react variants, which tsserver needs", () => {
    // Announcing a .tsx file as "typescript" makes tsserver reject its first
    // JSX tag as a syntax error.
    expect(lspLanguageForPath("src/App.tsx")).toBe("typescriptreact");
    expect(lspLanguageForPath("src/app.ts")).toBe("typescript");
    expect(lspLanguageForPath("src/App.jsx")).toBe("javascriptreact");
    expect(lspLanguageForPath("src/app.js")).toBe("javascript");
  });

  it("maps the module extensions to the same language", () => {
    for (const f of ["a.mts", "a.cts"]) expect(lspLanguageForPath(f)).toBe("typescript");
    for (const f of ["a.mjs", "a.cjs"]) expect(lspLanguageForPath(f)).toBe("javascript");
  });

  it("reads a whole filename when there is a rule for it", () => {
    // tsconfig.json permits comments, which a strict JSON server flags.
    expect(lspLanguageForPath("/repo/tsconfig.json")).toBe("jsonc");
    expect(lspLanguageForPath("/repo/data.json")).toBe("json");
    expect(lspLanguageForPath("/repo/Dockerfile")).toBe("dockerfile");
  });

  it("is case-insensitive about the extension", () => {
    expect(lspLanguageForPath("src/App.TSX")).toBe("typescriptreact");
  });

  it("handles Windows separators", () => {
    expect(lspLanguageForPath("C:\\repo\\src\\app.ts")).toBe("typescript");
  });

  it("returns null when nothing serves the file", () => {
    for (const f of ["notes.txt", "image.png", "LICENSE", "/repo/.gitignore", "noextension"]) {
      expect(lspLanguageForPath(f)).toBeNull();
    }
  });
});

describe("serversForLanguage", () => {
  it("finds the TypeScript server for all four of its languages", () => {
    for (const lang of ["typescript", "typescriptreact", "javascript", "javascriptreact"]) {
      expect(serversForLanguage(lang).map((s) => s.id)).toContain("typescript");
    }
  });

  it("returns nothing for a language no server claims", () => {
    expect(serversForLanguage("plaintext")).toEqual([]);
  });
});

describe("the registry itself", () => {
  it("has unique ids", () => {
    const ids = LANGUAGE_SERVERS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every server an install hint, since a missing one is the normal case", () => {
    for (const server of LANGUAGE_SERVERS) {
      expect(server.installHint.length).toBeGreaterThan(0);
      expect(server.displayName.length).toBeGreaterThan(0);
      expect(server.languages.length).toBeGreaterThan(0);
    }
  });

  it("never puts a shell metacharacter in a command or argument", () => {
    // These are spawned as argv, not through a shell, but a command containing
    // one would mean the table itself was built wrong.
    for (const server of LANGUAGE_SERVERS) {
      expect(server.command).toMatch(/^[a-zA-Z0-9._-]+$/);
      for (const arg of server.args) expect(arg).toMatch(/^[a-zA-Z0-9._=-]+$/);
    }
  });

  it("serves every language the extension map can produce", () => {
    // A file PPM offers to open with a language id nothing claims would report
    // "no server" forever with no way to tell it from a missing install.
    const served = new Set(LANGUAGE_SERVERS.flatMap((s) => s.languages));
    const produced = new Set(
      ["a.ts", "a.tsx", "a.js", "a.jsx", "a.py", "a.go", "a.rs", "a.c", "a.cpp",
       "a.json", "tsconfig.json", "a.html", "a.css", "a.scss", "a.less", "a.yaml",
       "a.sh", "a.php", "a.rb", "a.lua", "a.vue", "a.svelte"]
        .map((f) => lspLanguageForPath(f)!),
    );

    expect([...produced].filter((lang) => !served.has(lang))).toEqual([]);
  });

  it("looks a server up by id", () => {
    expect(serverById("gopls")?.command).toBe("gopls");
    expect(serverById("nope")).toBeUndefined();
  });
});

describe("ancestorDirs", () => {
  it("walks from the file's directory up to the project root", () => {
    expect(ancestorDirs("/repo/packages/web/src/app.ts", "/repo", "linux")).toEqual([
      "/repo/packages/web/src",
      "/repo/packages/web",
      "/repo/packages",
      "/repo",
    ]);
  });

  it("stops at the project root rather than walking to the filesystem root", () => {
    // Past the root it would find a tsconfig.json in the user's home directory
    // and root a server there, indexing everything they own.
    expect(ancestorDirs("/home/ada/repo/src/a.ts", "/home/ada/repo", "linux"))
      .toEqual(["/home/ada/repo/src", "/home/ada/repo"]);
  });

  it("yields just the root for a file directly in it", () => {
    expect(ancestorDirs("/repo/a.ts", "/repo", "linux")).toEqual(["/repo"]);
  });

  it("tolerates a trailing separator on the project path", () => {
    expect(ancestorDirs("/repo/src/a.ts", "/repo/", "linux")).toEqual(["/repo/src", "/repo"]);
  });

  it("walks a Windows path", () => {
    expect(ancestorDirs("C:\\repo\\src\\a.ts", "C:\\repo", "win32"))
      .toEqual(["C:\\repo\\src", "C:\\repo"]);
  });

  it("offers only the root for a file outside the project", () => {
    // Every directory this answers with is searched for `node_modules/.bin/<server>` and the
    // binary found there is *executed*, and searched for a root marker that becomes a
    // server's rootUri. So a directory the user never registered has no business being here.
    // The walk used to stop by comparing path *lengths*, which holds for a file inside the
    // project and not at all for one outside it.
    expect(ancestorDirs("/elsewhere/a.ts", "/repo", "linux")).toEqual(["/repo"]);
    expect(ancestorDirs("/home/ada/notes/x.ts", "/home/ada/repo", "linux")).toEqual(["/home/ada/repo"]);
    expect(ancestorDirs("/home/ada/repo-other/deep/nested/x.ts", "/home/ada/repo", "linux"))
      .toEqual(["/home/ada/repo"]);
  });

  it("does not take a sibling sharing the project's name as being inside it", () => {
    expect(ancestorDirs("/home/ada/repository/a.ts", "/home/ada/repo", "linux"))
      .toEqual(["/home/ada/repo"]);
  });

  it("recognises its own root through Windows' case-insensitivity", () => {
    // A project registered as `c:\users\ada\repo` and a file arriving as `C:\Users\Ada\...`
    // are one directory. Case-sensitively the walk never matches its root, so it climbs to
    // `C:\` — putting `C:\Users\node_modules\.bin` on the list of binaries to run.
    expect(ancestorDirs("C:\\Users\\Ada\\Repo\\src\\a.ts", "c:\\users\\ada\\repo", "win32"))
      .toEqual(["C:\\Users\\Ada\\Repo\\src", "C:\\Users\\Ada\\Repo"]);
  });

  it("offers only the root for a Windows file outside the project", () => {
    expect(ancestorDirs("C:\\Users\\ada\\repo-other\\a.ts", "C:\\Users\\ada\\repo", "win32"))
      .toEqual(["C:\\Users\\ada\\repo"]);
  });
});

describe("candidateCommandPaths", () => {
  it("prefers a project-local server over the global one", () => {
    // A repository pinned to an older TypeScript must be analysed by its own
    // server, which is what VS Code's "Use Workspace Version" does.
    const out = candidateCommandPaths("typescript-language-server", ["/repo/packages/web", "/repo"], "linux");

    expect(out).toEqual([
      "/repo/packages/web/node_modules/.bin/typescript-language-server",
      "/repo/node_modules/.bin/typescript-language-server",
      "typescript-language-server",
    ]);
  });

  it("ends with the bare command so PATH is the last resort", () => {
    const out = candidateCommandPaths("gopls", ["/repo"], "linux");
    expect(out.at(-1)).toBe("gopls");
  });

  it("tries the .cmd shim first on Windows", () => {
    // The extensionless file npm writes beside it is a shell script that
    // Windows cannot execute.
    const out = candidateCommandPaths("tsserver", ["C:\\repo"], "win32");

    expect(out.slice(0, 3)).toEqual([
      "C:\\repo\\node_modules\\.bin\\tsserver.cmd",
      "C:\\repo\\node_modules\\.bin\\tsserver.exe",
      "C:\\repo\\node_modules\\.bin\\tsserver",
    ]);
  });
});

describe("bundledServerEntry", () => {
  const typescript = serverById("typescript")!;

  it("finds the copy PPM ships, which is neither the project's nor on PATH", () => {
    // `npm i -g ppm` puts it in PPM's *own* node_modules. Without this lookup the server PPM
    // depends on is installed and unreachable, and a fresh install has no TypeScript until
    // the user installs a second copy globally.
    const entry = bundledServerEntry(typescript);

    expect(entry).not.toBeNull();
    // Built with `sep`, like the `.bin` check below: the entry comes from `path.resolve`, so it
    // is backslash-separated on Windows and a forward-slash literal never matches there.
    expect(entry!.endsWith(`${sep}typescript-language-server${sep}lib${sep}cli.mjs`)).toBe(true);
    expect(Bun.file(entry!).size).toBeGreaterThan(0);
  });

  it("answers with the package's entry, never npm's .bin shim", () => {
    // The shim is `#!/usr/bin/env node`, and someone who installed PPM with bun may have no
    // node at all — measured: spawning it with nothing named `node` on PATH exits 127, long
    // after the server was reported as installed. The caller runs this with `process.execPath`.
    const entry = bundledServerEntry(typescript)!;

    expect(entry).not.toContain(`${sep}.bin${sep}`);
    expect(readFileSync(entry, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("is null for a server PPM does not ship", () => {
    // Answering with a path nothing ever wrote would make every one of them look installed
    // until the spawn failed.
    for (const id of ["pyright", "gopls", "rust-analyzer", "clangd"]) {
      expect(bundledServerEntry(serverById(id)!)).toBeNull();
    }
  });

  it("only claims a package that is a real dependency of PPM", () => {
    // A `bundledPackage` naming something absent is the same silent-wrong-path failure.
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };
    const claimed = LANGUAGE_SERVERS.filter((s) => s.bundledPackage).map((s) => s.bundledPackage!);

    expect(claimed).toEqual(["typescript-language-server"]);
    for (const pkg of claimed) expect(manifest.dependencies[pkg]).toBeDefined();
    // The server is useless without a tsserver.js to drive; 7.x is the native port and ships
    // none, which is why the major is pinned rather than left to float.
    expect(manifest.dependencies.typescript).toMatch(/^\^?5\./);
  });

  it("answers null rather than throwing when the package is not installed", () => {
    const entry = bundledServerEntry(typescript, () => {
      throw new Error("Cannot find module");
    });

    expect(entry).toBeNull();
  });

  it("answers null for a package with no bin entry for this command", () => {
    // A `bundledPackage` that is a library rather than a server. Guessing a path here is the
    // same silent-wrong-path failure as claiming a package that is not installed.
    const entry = bundledServerEntry(
      { ...typescript, command: "not-a-bin-of-this-package" },
      (spec) => require.resolve(spec),
    );

    expect(entry).toBeNull();
  });
});

describe("where the manager looks, in order", () => {
  /** Just `resolveCommand`, so a failure here prints a function and not the whole file. */
  function resolveCommandBody(): string {
    const src = readFileSync("src/services/lsp/lsp-manager.ts", "utf8");
    const start = src.indexOf("private async resolveCommand");
    return src.slice(start, src.indexOf("\n  }\n", start));
  }

  it("puts the bundled copy last, behind the project's and PATH", () => {
    // The floor, not a preference: a repository pinned to its own server, and a server the
    // user deliberately installed, both have to win over whatever PPM happens to carry.
    const body = resolveCommandBody();
    const order = ["candidateCommandPaths", "Bun.which", "bundledServerEntry"];

    expect(order.map((name) => body.indexOf(name))).toEqual([...order.map((n) => body.indexOf(n))].sort((a, b) => a - b));
    for (const name of order) expect(body.indexOf(name)).toBeGreaterThan(-1);
  });

  it("runs the bundled copy with PPM's own runtime", () => {
    expect(resolveCommandBody()).toContain("[process.execPath, bundled]");
  });
});
