/**
 * The manager against the fake server fixture.
 *
 * What is worth testing here is not "does it start a server" but the sharing
 * rules: one process for many tabs, a separate process for a separate project
 * root, and no process left behind. Getting those wrong is invisible in a demo
 * and fatal on a real machine.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { LspManager, isUnavailable, type LspHandle } from "../../../../src/services/lsp/lsp-manager.ts";
import type { LanguageServerDefinition } from "../../../../src/services/lsp/server-registry.ts";

const FIXTURE = resolve(import.meta.dir, "../../../fixtures/fake-language-server.ts");

/** Serves `.lua` files, because the real Lua server is not what we are testing. */
const FAKE: LanguageServerDefinition = {
  id: "fake",
  displayName: "Fake",
  languages: ["lua"],
  command: "bun",
  args: [FIXTURE],
  rootMarkers: [".fakeroot"],
  installHint: "it is a fixture",
};

const MISSING: LanguageServerDefinition = {
  ...FAKE,
  id: "missing",
  displayName: "Missing Server",
  command: "definitely-not-installed-anywhere",
  installHint: "bun add -g nothing",
};

let project: string;
let manager: LspManager;

function make(servers: LanguageServerDefinition[] = [FAKE], graceMs = 60_000, maxSessions = 6): LspManager {
  manager = new LspManager(servers, graceMs, maxSessions);
  return manager;
}

/**
 * An install directory as `bun add` would leave it: one package, whose `bin` points at a
 * server. The entry is the fixture, so the manager has something that really answers.
 */
function installDirWithFakeServer(): string {
  const dir = mkdtempSync(join(tmpdir(), "ppm-lsp-installed-"));
  extraProjects.push(dir);
  const pkgDir = join(dir, "node_modules", "fake-lsp-package");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "fake-lsp-package", bin: { "fake-installed-server": "server.ts" } }),
  );
  writeFileSync(join(pkgDir, "server.ts"), `import ${JSON.stringify(FIXTURE)};\n`);
  return dir;
}

/** A second, third… project root, so one manager starts more than one server. */
function anotherProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ppm-lsp-"));
  extraProjects.push(dir);
  writeFileSync(join(dir, ".fakeroot"), "");
  writeFileSync(join(dir, "a.lua"), "print('a')\n");
  return dir;
}

const extraProjects: string[] = [];

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "ppm-lsp-"));
  writeFileSync(join(project, ".fakeroot"), "");
  writeFileSync(join(project, "a.lua"), "print('a')\n");
});

afterEach(async () => {
  await manager?.disposeAll();
  rmSync(project, { recursive: true, force: true });
  for (const dir of extraProjects.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("LspManager.acquire", () => {
  it("starts a server and reports the language", async () => {
    const result = await make().acquire(project, "a.lua", "socket-1");

    expect(isUnavailable(result)).toBe(false);
    const handle = result as LspHandle;
    expect(handle.language).toBe("lua");
    expect(handle.session.state).toBe("ready");
  });

  it("shares one process between two subscribers", async () => {
    // Ten open TypeScript tabs must not be ten tsservers.
    const m = make();
    const first = (await m.acquire(project, "a.lua", "socket-1")) as LspHandle;
    const second = (await m.acquire(project, "b.lua", "socket-2")) as LspHandle;

    expect(second.session).toBe(first.session);
    expect(m.running()).toHaveLength(1);
    expect(m.running()[0]!.subscribers).toBe(2);
  });

  it("does not spawn twice when two tabs open at the same moment", async () => {
    const m = make();

    const [a, b] = await Promise.all([
      m.acquire(project, "a.lua", "socket-1"),
      m.acquire(project, "b.lua", "socket-2"),
    ]);

    expect((a as LspHandle).session).toBe((b as LspHandle).session);
    expect(m.running()).toHaveLength(1);
  });

  it("gives a nested root its own server", async () => {
    // A monorepo package with its own root marker is a different project with
    // different types; one server rooted at the top would answer with the
    // wrong ones.
    mkdirSync(join(project, "packages", "web"), { recursive: true });
    writeFileSync(join(project, "packages", "web", ".fakeroot"), "");
    writeFileSync(join(project, "packages", "web", "c.lua"), "print('c')\n");
    const m = make();

    const outer = (await m.acquire(project, "a.lua", "s1")) as LspHandle;
    const inner = (await m.acquire(project, "packages/web/c.lua", "s1")) as LspHandle;

    expect(inner.session).not.toBe(outer.session);
    expect(inner.session.rootPath).toBe(join(project, "packages", "web"));
    expect(outer.session.rootPath).toBe(project);
    expect(m.running()).toHaveLength(2);
  });

  it("roots at the project when no marker is found", async () => {
    // Rooting at the file's own directory would make the server see no imports
    // and report every one as missing, which looks like a broken install.
    rmSync(join(project, ".fakeroot"));
    mkdirSync(join(project, "deep", "nested"), { recursive: true });
    writeFileSync(join(project, "deep", "nested", "d.lua"), "print('d')\n");

    const handle = (await make().acquire(project, "deep/nested/d.lua", "s1")) as LspHandle;

    expect(handle.session.rootPath).toBe(project);
  });

  it("says no-language for a file nothing serves", async () => {
    const result = await make().acquire(project, "notes.txt", "s1");

    expect(isUnavailable(result) && result.reason).toBe("no-language");
  });

  it("says not-installed, with the command to fix it", async () => {
    const result = await make([MISSING]).acquire(project, "a.lua", "s1");

    expect(isUnavailable(result) && result.reason).toBe("not-installed");
    expect(isUnavailable(result) && result.server?.installHint).toBe("bun add -g nothing");
  });

  it("says whether PPM could install the missing one, which is what the button hangs off", async () => {
    // The registry's answer, not the editor's guess: a server that comes from a toolchain has
    // only a command to copy, and offering a button that cannot work is worse than no button.
    const fromToolchain = await make([MISSING]).acquire(project, "a.lua", "s1");
    expect(isUnavailable(fromToolchain) && fromToolchain.server?.installable).toBe(false);

    const fromNpm = await make([{ ...MISSING, install: { with: "bun", packages: ["nothing-at-all"] } }])
      .acquire(project, "a.lua", "s2");
    expect(isUnavailable(fromNpm) && fromNpm.server?.installable).toBe(true);
  });

  it("finds and starts a server the Install button put in PPM's own directory", async () => {
    // Neither the project's `node_modules/.bin` nor PATH: `bun add` into PPM's own directory
    // leaves a package with a `bin`, and the manager runs that entry with bun. This is the
    // whole path the button depends on — the command below is on no PATH anywhere.
    const installDir = installDirWithFakeServer();
    const installed: LanguageServerDefinition = {
      ...FAKE,
      id: "installed",
      command: "fake-installed-server",
      args: [],
      install: { with: "bun", packages: ["fake-lsp-package"] },
    };
    expect(Bun.which("fake-installed-server")).toBeNull();

    manager = new LspManager([installed], 60_000, 6, () => installDir);
    const result = await manager.acquire(project, "a.lua", "s1");

    expect(isUnavailable(result)).toBe(false);
    expect((result as LspHandle).session.state).toBe("ready");
  });

  it("asks rustup before PATH, because the proxy on PATH lies", () => {
    // `~/.cargo/bin/rust-analyzer` is a rustup proxy that exists whether or not the component
    // does — measured on this host, with the component absent, the symlink was right there. A
    // PATH hit therefore reports an installed server that prints "unknown binary" and exits
    // when spawned: a broken server instead of the missing one the Install button is for.
    //
    // Asserted against the source rather than by running it, because the fake binary would have
    // to go on PATH and `Bun.which` cannot see one put there: it reads the PATH the *process*
    // started with and never looks at `process.env.PATH` again (measured — adding a directory
    // changes nothing, and so does emptying it). Only the explicit `{ PATH }` option is live.
    const source = readFileSync(resolve(import.meta.dir, "../../../../src/services/lsp/lsp-manager.ts"), "utf8");
    const body = source.slice(source.indexOf("private async resolveCommand"));

    expect(body.indexOf("rustupServerPath")).toBeLessThan(body.indexOf("Bun.which"));
  });

  it("falls through a missing server to an installed one", async () => {
    // Preference order matters: a project-pinned server that is absent must
    // not mask the one that works.
    const result = await make([MISSING, FAKE]).acquire(project, "a.lua", "s1");

    expect(isUnavailable(result)).toBe(false);
    expect((result as LspHandle).session.definition.id).toBe("fake");
  });

  it("starts a fresh server after the previous one crashed", async () => {
    process.env.FAKE_LSP_MODE = "crash";
    const m = make();
    const first = (await m.acquire(project, "a.lua", "s1")) as LspHandle;
    await Bun.sleep(300);
    expect(first.session.state).toBe("crashed");
    delete process.env.FAKE_LSP_MODE;

    const second = (await m.acquire(project, "a.lua", "s1")) as LspHandle;

    expect(second.session).not.toBe(first.session);
    expect(second.session.state).toBe("ready");
  });
});

describe("LspManager.release", () => {
  it("keeps the server running after the last release", async () => {
    // Closing and reopening a tab is the commonest thing a person does; paying
    // a cold start each time would be worse than holding the process.
    const m = make();
    const handle = (await m.acquire(project, "a.lua", "s1")) as LspHandle;

    m.release(handle.key, "s1");

    expect(handle.session.state).toBe("ready");
    expect(m.running()).toHaveLength(1);
  });

  it("shuts the server down once the grace period expires", async () => {
    const m = make([FAKE], 120);
    const handle = (await m.acquire(project, "a.lua", "s1")) as LspHandle;

    m.release(handle.key, "s1");
    await Bun.sleep(400);

    expect(handle.session.state).toBe("stopped");
    expect(m.running()).toHaveLength(0);
  });

  it("cancels the reap when a tab reopens inside the grace period", async () => {
    const m = make([FAKE], 200);
    const handle = (await m.acquire(project, "a.lua", "s1")) as LspHandle;
    m.release(handle.key, "s1");

    const again = (await m.acquire(project, "a.lua", "s2")) as LspHandle;
    await Bun.sleep(400);

    expect(again.session).toBe(handle.session);
    expect(again.session.state).toBe("ready");
  });

  it("keeps it alive while another subscriber still holds it", async () => {
    const m = make([FAKE], 120);
    const first = (await m.acquire(project, "a.lua", "s1")) as LspHandle;
    await m.acquire(project, "b.lua", "s2");

    m.release(first.key, "s1");
    await Bun.sleep(300);

    expect(first.session.state).toBe("ready");
  });

  it("drops every hold a closing socket had", async () => {
    const m = make([FAKE], 120);
    const handle = (await m.acquire(project, "a.lua", "s1")) as LspHandle;

    m.releaseAll("s1");
    await Bun.sleep(300);

    expect(handle.session.state).toBe("stopped");
  });
});

describe("LspManager.availability", () => {
  it("reports what is installed and what is not", async () => {
    const rows = await make([FAKE, MISSING]).availability(project);

    expect(rows.find((r) => r.id === "fake")?.installed).toBe(true);
    expect(rows.find((r) => r.id === "missing")).toMatchObject({
      installed: false,
      installHint: "bun add -g nothing",
      displayName: "Missing Server",
    });
  });
});

describe("LspManager.disposeAll", () => {
  it("leaves no process behind", async () => {
    const m = make();
    const handle = (await m.acquire(project, "a.lua", "s1")) as LspHandle;
    const pid = (handle.session as unknown as { proc: { pid: number } }).proc.pid;

    await m.disposeAll();

    expect(m.running()).toHaveLength(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("the session cap", () => {
  it("shuts down the least recently used idle server once the cap is passed", async () => {
    // A session is started per server *and root directory*, so one file open in each of a
    // dozen projects is a dozen servers — and the idle grace keeps every one of them for five
    // minutes after the tab closes. One `typescript-language-server` was 854 MB resident.
    const m = make([FAKE], 60_000, 2);
    const roots = [project, anotherProject(), anotherProject()];

    const handles: LspHandle[] = [];
    for (const [i, root] of roots.entries()) {
      const handle = (await m.acquire(root, "a.lua", `s${i}`)) as LspHandle;
      handles.push(handle);
      m.release(handle.key, `s${i}`); // the tab closed; the grace period is what kept it alive
    }

    expect(m.running()).toHaveLength(2);
    // The first root is the one that has gone.
    expect(m.running().map((r) => r.rootPath)).toEqual([roots[1]!, roots[2]!]);
    // The eviction does not block the acquire that triggered it, so the polite handshake is
    // still in flight at this point.
    for (let i = 0; i < 40 && handles[0]!.session.state !== "stopped"; i++) await Bun.sleep(25);
    expect(handles[0]!.session.state).toBe("stopped");
  });

  it("never takes a server an editor is still open on", async () => {
    // The bridge cannot re-open a document on a session that vanished underneath it: that tab
    // would answer "the language server is no longer running" until it was closed and opened
    // again, which is worse than the memory.
    const m = make([FAKE], 60_000, 1);
    const roots = [project, anotherProject(), anotherProject()];

    const held: LspHandle[] = [];
    for (const [i, root] of roots.entries()) held.push((await m.acquire(root, "a.lua", `s${i}`)) as LspHandle);

    expect(m.running()).toHaveLength(3);
    expect(held.every((h) => h.session.state === "ready")).toBe(true);
  });

  it("counts a reused server as recently used", async () => {
    const m = make([FAKE], 60_000, 2);
    const roots = [project, anotherProject(), anotherProject()];
    const keys: string[] = [];
    for (const [i, root] of roots.slice(0, 2).entries()) {
      const handle = (await m.acquire(root, "a.lua", `s${i}`)) as LspHandle;
      keys.push(handle.key);
      m.release(handle.key, `s${i}`);
    }

    // Touch the older one, then start a third: the untouched one is what goes.
    const reused = (await m.acquire(roots[0]!, "a.lua", "again")) as LspHandle;
    m.release(reused.key, "again");
    const third = (await m.acquire(roots[2]!, "a.lua", "s2")) as LspHandle;
    m.release(third.key, "s2");

    expect(m.running().map((r) => r.rootPath).sort()).toEqual([roots[0]!, roots[2]!].sort());
  });
});
