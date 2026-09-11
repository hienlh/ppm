/**
 * The manager against the fake server fixture.
 *
 * What is worth testing here is not "does it start a server" but the sharing
 * rules: one process for many tabs, a separate process for a separate project
 * root, and no process left behind. Getting those wrong is invisible in a demo
 * and fatal on a real machine.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

function make(servers: LanguageServerDefinition[] = [FAKE], graceMs = 60_000): LspManager {
  manager = new LspManager(servers, graceMs);
  return manager;
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "ppm-lsp-"));
  writeFileSync(join(project, ".fakeroot"), "");
  writeFileSync(join(project, "a.lua"), "print('a')\n");
});

afterEach(async () => {
  await manager?.disposeAll();
  rmSync(project, { recursive: true, force: true });
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
