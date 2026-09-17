import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  LANGUAGE_SERVERS,
  ancestorDirs,
  bundledServerEntry,
  candidateCommandPaths,
  installedBinaryPath,
  installedServerEntry,
  lspLanguageForPath,
  packageName,
  serverById,
  serversForLanguage,
  serversSharingInstall,
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
    expect(entry!.endsWith("/typescript-language-server/lib/cli.mjs")).toBe(true);
    expect(Bun.file(entry!).size).toBeGreaterThan(0);
  });

  it("answers with the package's entry, never npm's .bin shim", () => {
    // The shim is `#!/usr/bin/env node`, and someone who installed PPM with bun may have no
    // node at all — measured: spawning it with nothing named `node` on PATH exits 127, long
    // after the server was reported as installed. The caller runs this with bun.
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

describe("installedServerEntry", () => {
  const typescript = serverById("typescript")!;

  /** An install directory holding one package, as `bun add` would leave it. */
  function installDirWith(pkg: string, bin: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "ppm-lsp-install-"));
    const pkgDir = join(dir, "node_modules", ...pkg.split("/"));
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: pkg, bin }));
    installDirs.push(dir);
    return dir;
  }

  const installDirs: string[] = [];
  afterEach(() => {
    for (const dir of installDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("finds the entry of what the Install button put in PPM's own directory", () => {
    const dir = installDirWith("typescript-language-server", { "typescript-language-server": "lib/cli.mjs" });

    expect(installedServerEntry(typescript, dir))
      .toBe(join(dir, "node_modules", "typescript-language-server", "lib", "cli.mjs"));
  });

  it("stays inside that directory rather than climbing out of it", () => {
    // Node resolution walks *up* from where it starts, so a stray `~/node_modules` beside the
    // PPM directory would answer for a package PPM never installed — and whatever answers here
    // is executed.
    const dir = mkdtempSync(join(tmpdir(), "ppm-lsp-install-"));
    installDirs.push(dir);
    const outside = join(dir, "node_modules");
    mkdirSync(join(dir, "inner"), { recursive: true });
    mkdirSync(join(outside, "typescript-language-server"), { recursive: true });
    writeFileSync(
      join(outside, "typescript-language-server", "package.json"),
      JSON.stringify({ name: "typescript-language-server", bin: { "typescript-language-server": "cli.mjs" } }),
    );

    expect(installedServerEntry(typescript, join(dir, "inner"))).toBeNull();
  });

  it("reads the scoped name whole", () => {
    const vue = serverById("vue")!;
    const dir = installDirWith("@vue/language-server", { "vue-language-server": "bin/vue-language-server.js" });

    expect(installedServerEntry(vue, dir))
      .toBe(join(dir, "node_modules", "@vue", "language-server", "bin", "vue-language-server.js"));
  });

  it("is null for a server PPM cannot install, and for one that is simply absent", () => {
    const dir = installDirWith("typescript-language-server", { "typescript-language-server": "lib/cli.mjs" });

    // gopls comes from a toolchain; nothing is ever installed for it, so nothing may be claimed.
    expect(installedServerEntry(serverById("gopls")!, dir)).toBeNull();
    expect(installedServerEntry(serverById("pyright")!, dir)).toBeNull();
  });

  it("is null when the package is there but provides no such command", () => {
    // A package that dropped or renamed its binary. Guessing a path here is a spawn failure
    // reported long after the server was called installed.
    const dir = installDirWith("typescript-language-server", { "something-else": "lib/cli.mjs" });

    expect(installedServerEntry(typescript, dir)).toBeNull();
  });
});

describe("what the Install button will run", () => {
  const installable = LANGUAGE_SERVERS.filter((s) => s.install);

  it("offers every server PPM can install without a system package manager", () => {
    expect(installable.map((s) => s.id).sort()).toEqual([
      "bash", "css", "gopls", "html", "intelephense", "json",
      "pyright", "rust-analyzer", "svelte", "typescript", "vue", "yaml",
    ]);
    // Left out on purpose: clangd, lua-language-server and solargraph mean pacman, apt, brew
    // or a gem — a password, and a choice about the machine PPM has no business making.
    for (const id of ["clangd", "solargraph", "lua"]) {
      expect(serverById(id)!.install).toBeUndefined();
    }
  });

  it("runs exactly what the hint tells the user to run", () => {
    // The hint is what a user runs by hand; the plan is what the button runs. Two descriptions
    // that can drift are two different installs, and only one of them is ever tested.
    for (const server of installable) {
      const plan = server.install!;
      const expected =
        plan.with === "bun" ? `bun add -g ${plan.packages.join(" ")}`
        : plan.with === "go" ? `go install ${plan.module}`
        : `rustup component add ${plan.component}`;
      expect(server.installHint).toBe(expected);
    }
  });

  it("names a package, a module or a component — never a flag or a path", () => {
    // Every one of these is argv, so anything shaped like an option or a local path would be a
    // different command than the one the table claims to describe.
    for (const server of installable) {
      const plan = server.install!;
      const specs = plan.with === "bun" ? plan.packages : [plan.with === "go" ? plan.module : plan.component];
      for (const spec of specs) {
        expect(spec.startsWith("-")).toBe(false);
        expect(spec).not.toContain(" ");
        expect(spec).not.toContain("..");
      }
    }
    // And the npm ones are package specs, since they are handed to `bun add`.
    for (const server of installable.filter((s) => s.install!.with === "bun")) {
      for (const spec of (server.install as { packages: string[] }).packages) {
        expect(spec).toMatch(/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[^@\s]+)?$/);
      }
    }
  });

  it("only looks in PPM's own bin directory for a server it builds there", () => {
    // `GOBIN` puts it there, so this is where it is. The npm servers are packages rather than
    // binaries, and nothing PPM builds for them lands in `bin`.
    const gopls = serverById("gopls")!;
    expect(installedBinaryPath(gopls, "/ppm", "linux")).toBe("/ppm/bin/gopls");
    // Only the `.exe` is the platform's here — the separator is the *host's*, because the test
    // runner joins paths with whatever it is running on, not with the platform being asked about.
    expect(installedBinaryPath(gopls, "/ppm", "win32")).toBe(join("/ppm", "bin", "gopls.exe"));
    expect(installedBinaryPath(serverById("typescript")!, "/ppm")).toBeNull();
    // rust-analyzer belongs to a rustup toolchain; PPM keeps no copy to find.
    expect(installedBinaryPath(serverById("rust-analyzer")!, "/ppm")).toBeNull();
    expect(installedServerEntry(serverById("rust-analyzer")!, "/ppm")).toBeNull();
  });
});

describe("packageName", () => {
  it("drops the version and keeps the scope", () => {
    expect(packageName("typescript@5")).toBe("typescript");
    expect(packageName("typescript-language-server")).toBe("typescript-language-server");
    expect(packageName("@vue/language-server")).toBe("@vue/language-server");
    expect(packageName("@vue/language-server@3.3.11")).toBe("@vue/language-server");
  });
});

describe("where the manager looks, in order", () => {
  /** Just `resolveCommand`, so a failure here prints a function and not the whole file. */
  function resolveCommandBody(): string {
    const src = readFileSync("src/services/lsp/lsp-manager.ts", "utf8");
    const start = src.indexOf("private async resolveCommand");
    return src.slice(start, src.indexOf("\n  }\n", start));
  }

  it("puts the bundled copy last, behind the project's, PATH and the installed one", () => {
    // The floor, not a preference: a repository pinned to its own server, a server the user
    // deliberately installed, and one the Install button fetched all have to win over whatever
    // PPM happens to carry.
    const body = resolveCommandBody();
    const order = ["candidateCommandPaths", "Bun.which", "installedServerEntry", "bundledServerEntry"];

    expect(order.map((name) => body.indexOf(name))).toEqual([...order.map((n) => body.indexOf(n))].sort((a, b) => a - b));
    for (const name of order) expect(body.indexOf(name)).toBeGreaterThan(-1);
  });

  it("runs PPM's own copies with bun, never with the PPM executable", () => {
    // `process.execPath` is bun only while PPM runs from source. A compiled PPM is its own
    // executable, so `<ppm> <entry> --stdio` reaches PPM's CLI — which is how a compiled PPM
    // once answered `<ppm> x @openai/codex app-server` with "unknown command". Asserted on the
    // source because `bun test` always runs with an execPath that *is* bun, so no test run here
    // can tell the two apart.
    expect(resolveCommandBody()).toContain("bunRuntime()");
    expect(resolveCommandBody()).not.toContain("process.execPath");
  });
});

describe("serversSharingInstall", () => {
  it("names the servers one npm package provides together", () => {
    // `vscode-langservers-extracted` is JSON, HTML and CSS at once, so `bun remove` of it takes
    // all three whichever row the Remove button was on. The pane says so before asking, which
    // it can only do if this answers.
    const shared = serversSharingInstall(serverById("json")!).map((s) => s.id).sort();

    expect(shared).toEqual(["css", "html"]);
  });

  it("answers with nothing for a package, module or component that is its own", () => {
    for (const id of ["typescript", "pyright", "gopls", "rust-analyzer", "clangd"]) {
      expect(serversSharingInstall(serverById(id)!)).toEqual([]);
    }
  });
});
