import { describe, it, expect } from "bun:test";
import {
  LANGUAGE_SERVERS,
  ancestorDirs,
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

  it("still offers the root for a file outside the project", () => {
    expect(ancestorDirs("/elsewhere/a.ts", "/repo", "linux")).toContain("/repo");
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
