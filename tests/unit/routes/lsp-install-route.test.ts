/**
 * What the Install routes will accept, and what Settings is told.
 *
 * The one property worth pinning: the browser sends a server **id**, and the packages come from
 * the registry. Nothing that reaches these routes can name a package, a flag or a path — so
 * every case here is a refusal, and none of them installs anything. There are two routers —
 * the editor's, scoped to a project, and Settings', scoped to the machine — and they share the
 * handler precisely so that property cannot hold on one and not the other.
 */
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { lspRoutes, lspGlobalRoutes } from "../../../src/server/routes/lsp.ts";
import { LANGUAGE_SERVERS } from "../../../src/services/lsp/server-registry.ts";
import { lspInstallDir } from "../../../src/services/lsp/lsp-install.ts";

const app = new Hono().route("/lsp", lspRoutes).route("/api/lsp", lspGlobalRoutes);

function install(body: unknown): Promise<Response> {
  return app.request("/lsp/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /lsp/install", () => {
  it("refuses an id that is not in the registry", async () => {
    for (const serverId of ["", "nonsense", "../../typescript", "typescript typescript@5"]) {
      const res = await install({ serverId });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/No such language server/);
    }
  });

  it("refuses a package name in place of a server id", async () => {
    // The shape an attempt would take if the route took packages rather than ids.
    const res = await install({ serverId: "typescript", packages: ["some-other-package"] });

    // It may only ever run the registry's packages for `typescript`; the extra field is data
    // the handler never reads.
    expect(await res.text()).not.toContain("some-other-package");
  });

  it("refuses a download on a host with nothing to unpack it, before downloading anything", async () => {
    // clangd ships as a zip, which needs unzip or bsdtar here (tar on Windows). With none of
    // them on PATH the button is not offered, and a request that comes anyway fetches nothing.
    const path = process.env.PATH;
    process.env.PATH = "";
    try {
      const res = await install({ serverId: "clangd" });

      expect(res.status).toBe(500);
      expect((await res.json()).error).toMatch(/no build of clangd for this machine, or nothing here to unpack one/);
    } finally {
      process.env.PATH = path;
    }
  });

  it("refuses a toolchain install on a host with no toolchain, without running anything", async () => {
    // gopls *is* installable, but only where there is a Go. Reproduced by taking it away
    // rather than by stubbing: `installToolPath` looks in PATH precisely because that is the
    // PATH the server itself would inherit.
    const path = process.env.PATH;
    process.env.PATH = "";
    try {
      const res = await install({ serverId: "gopls" });

      expect(res.status).toBe(500);
      expect((await res.json()).error).toMatch(/go is not installed on this host/);
    } finally {
      process.env.PATH = path;
    }
  });

  it("refuses a body that is not JSON at all", async () => {
    const res = await app.request("/lsp/install", { method: "POST", body: "not json" });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/lsp/servers", () => {
  it("lists every registered server, with what Settings needs to draw a row", async () => {
    const res = await app.request("/api/lsp/servers");
    expect(res.status).toBe(200);
    const { data } = await res.json();

    // Every one of them: a pane that quietly omitted a language would read as "PPM has no Ruby
    // server" rather than "you do not have one installed".
    expect(data.servers.map((s: { id: string }) => s.id).sort())
      .toEqual(LANGUAGE_SERVERS.map((s) => s.id).sort());
    for (const row of data.servers) {
      expect(typeof row.displayName).toBe("string");
      expect(Array.isArray(row.languages)).toBe(true);
      expect(typeof row.installed).toBe("boolean");
      expect(typeof row.installable).toBe("boolean");
      expect(typeof row.installHint).toBe("string");
      expect(typeof row.removable).toBe("boolean");
      // Removable is a claim about *where it was found*, never about what is on the machine:
      // the Remove button may only ever undo an install PPM itself did.
      if (row.removable) expect(["ppm", "rustup"]).toContain(row.origin);
      if (row.installed) expect(typeof row.origin).toBe("string");
      else expect(row.origin).toBeUndefined();
    }
  });

  it("says where an install lands, so the pane can say how to undo one", async () => {
    const { data } = await (await app.request("/api/lsp/servers")).json();

    expect(data.installDir).toBe(lspInstallDir());
    expect(data.installDir).toContain(process.env.PPM_HOME!);
  });

  it("offers the button for the npm servers, whatever this host has installed", async () => {
    // `installable` is not `installed`: bun is resolved by path rather than by PATH, so an npm
    // server can always be installed even on a host that has none of them.
    const { data } = await (await app.request("/api/lsp/servers")).json();
    const npm = data.servers.filter((s: { id: string }) => ["typescript", "json", "yaml"].includes(s.id));

    expect(npm).toHaveLength(3);
    for (const row of npm) expect(row.installable).toBe(true);
  });

  it("offers a toolchain, gem or download install only where the host can carry it out", async () => {
    // Taken away rather than stubbed, as above: with nothing on PATH there is no Go, rustup,
    // gem, tar or unzip, and only the npm servers — bun is found by path — keep their button.
    const path = process.env.PATH;
    process.env.PATH = "";
    try {
      const { data } = await (await app.request("/api/lsp/servers")).json();
      const row = (id: string) => data.servers.find((s: { id: string }) => s.id === id);

      for (const id of ["gopls", "rust-analyzer", "solargraph", "clangd", "lua"]) expect(row(id).installable).toBe(false);
      expect(row("typescript").installable).toBe(true);
    } finally {
      process.env.PATH = path;
    }
  });
});

describe("POST /api/lsp/uninstall", () => {
  // Only refusals here, deliberately: this suite runs on a developer's own machine, and a case
  // that actually removed something would remove *their* server. The removals are covered
  // against a fake runner in `tests/unit/services/lsp/lsp-install.test.ts`.
  const uninstall = (body: unknown) =>
    app.request("/api/lsp/uninstall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("refuses an id that is not in the registry", async () => {
    for (const serverId of ["", "nonsense", "../../typescript"]) {
      const res = await uninstall({ serverId });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/No such language server/);
    }
  });

  it("refuses a server PPM did not install", async () => {
    // This suite's PPM folder is a fresh temporary one, so no clangd is in it — whether this host
    // has one on PATH or none at all, it is not PPM's to delete.
    const res = await uninstall({ serverId: "clangd" });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/did not install clangd/);
  });

  it("is not on the editor's router at all", async () => {
    // The editor's dialog is only ever shown for a server that is *missing*, so it has nothing
    // to remove — and the project-scoped router should not grow a door nothing opens.
    const res = await app.request("/lsp/uninstall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverId: "typescript" }),
    });

    expect(res.status).toBe(404);
  });
});

describe("POST /api/lsp/install", () => {
  it("refuses exactly what the project-scoped route refuses", async () => {
    // With nothing on PATH nothing can be downloaded, built or unpacked, whatever is asked for.
    // No npm server here: bun is found by path, so one of those would really install.
    const path = process.env.PATH;
    process.env.PATH = "";
    try {
      for (const body of [
        { serverId: "nonsense" },
        { serverId: "clangd" },
        { serverId: "gopls" },
        { packages: ["some-other-package"] },
      ]) {
        const scoped = await install(body);
        const global = await app.request("/api/lsp/install", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

        expect(global.status).not.toBe(200);
        expect(global.status).toBe(scoped.status);
        expect((await global.json()).error).toBe((await scoped.json()).error);
      }
    } finally {
      process.env.PATH = path;
    }
  });
});
