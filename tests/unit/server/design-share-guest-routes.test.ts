import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configService } from "../../../src/services/config.service.ts";
import { getDb } from "../../../src/services/db.service.ts";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import { snapshotDir } from "../../../src/services/design/design-snapshot-history.ts";
import { updateShareLink } from "../../../src/services/design/share/design-share-links.service.ts";
import { resetShareSecretCache } from "../../../src/services/design/share/design-share-code.ts";
import { GUEST_PAGE_CSP, INVALID_PAGE_HTML } from "../../../src/services/design/share/design-share-guest-page.ts";
import { createStaticHandler } from "../../../src/server/routes/static.ts";
import { describeRequestTarget } from "../../../src/server/middleware/access-log.ts";
import { makeShareFixture, type ShareFixture } from "./design-share-guest-fixture.ts";

const COMMON = {
  "cache-control": "no-store", "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow", "x-content-type-options": "nosniff",
};

function expectCommonHeaders(res: Response): void {
  for (const [name, value] of Object.entries(COMMON)) expect(res.headers.get(name)).toBe(value);
  expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
}

describe("design share guest routes: page, info, refusals", () => {
  let f: ShareFixture;
  beforeEach(async () => { f = await makeShareFixture(); });
  afterEach(() => f.restore());

  it("serves the built page under its own CSP, and 503 while it is not built", async () => {
    const missing = await f.get();
    expect(missing.status).toBe(503);
    expectCommonHeaders(missing);
    mkdirSync(join(f.distDir, "design-share-page"), { recursive: true });
    writeFileSync(join(f.distDir, "design-share-page", "index.html"), "<!doctype html><title>Review</title>");
    const page = await f.get();
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>Review</title>");
    expect(page.headers.get("content-security-policy")).toBe(GUEST_PAGE_CSP);
    expect(GUEST_PAGE_CSP).toContain("frame-ancestors 'none'");
    expect(GUEST_PAGE_CSP).toContain("worker-src 'none'");
    expectCommonHeaders(page);
  });

  it("answers info from the snapshot's manifest, without the owner's label", async () => {
    // A rename after the pin changes the live manifest only.
    writeFileSync(join(f.designs, "home", "design.json"), JSON.stringify({ title: "Renamed live", kind: "deck" }));
    const res = await f.get("/info");
    expect(res.status).toBe(200);
    expectCommonHeaders(res);
    const { data } = await res.json();
    expect(data).toEqual({
      linkId: f.link.id, slug: "home", title: "Home", kind: "page", entry: "index.html",
      variants: [expect.objectContaining({ file: "index.html" })],
      expiresAt: null, versionCreatedAt: f.link.snapshotCreatedAt, versionId: f.link.snapshotId,
    });
    expect(JSON.stringify(data)).not.toContain("Client");
  });

  it("answers every reason a code does not open with the same 404 body", async () => {
    const page = async () => { const r = await f.get(); return { status: r.status, body: await r.text() }; };
    const info = async () => { const r = await f.get("/info"); return { status: r.status, body: await r.text() }; };
    const bodies: Array<{ status: number; body: string }> = [];
    const collect = async () => { bodies.push(await page(), await info()); };

    configService.set("auth", { ...configService.get("auth"), enabled: false });
    await collect();
    configService.set("auth", { ...configService.get("auth"), enabled: true });

    configService.set("projects", []);
    await collect();
    configService.set("projects", [{ name: "demo", path: f.project }]);

    getDb().prepare("UPDATE design_share_links SET expires_at = ? WHERE id = ?").run(Date.now() - 1, f.link.id);
    await collect();
    getDb().prepare("UPDATE design_share_links SET expires_at = NULL WHERE id = ?").run(f.link.id);

    rmSync(snapshotDir(join(f.designs, "home"), f.link.snapshotId), { recursive: true, force: true });
    await collect();

    const unknown = await f.app.request(`http://localhost/s/${"A".repeat(43)}`);
    bodies.push({ status: unknown.status, body: await unknown.text() });
    const unknownInfo = await f.app.request(`http://localhost/s/${"A".repeat(43)}/info`);
    bodies.push({ status: unknownInfo.status, body: await unknownInfo.text() });

    const pages = bodies.filter((_, i) => i % 2 === 0);
    const infos = bodies.filter((_, i) => i % 2 === 1);
    expect(new Set(pages.map((b) => `${b.status} ${b.body}`))).toEqual(new Set([`404 ${INVALID_PAGE_HTML}`]));
    expect(new Set(infos.map((b) => `${b.status} ${b.body}`)).size).toBe(1);
    expect(infos[0]!.status).toBe(404);
  });

  it("stops opening once revoked, and once the secret is replaced (needs a new code)", async () => {
    await updateShareLink(f.project, "home", f.link.id, { revoke: true });
    expect((await f.get("/info")).status).toBe(404);

    const other = await makeShareFixture();
    try {
      unlinkSync(resolve(getPpmDir(), "design-share.key"));
      resetShareSecretCache();
      expect((await other.get("/info")).status).toBe(404);
    } finally {
      other.restore();
    }
  });

  it("refuses every route while sign-in is off", async () => {
    configService.set("auth", { ...configService.get("auth"), enabled: false });
    for (const path of ["", "/info", "/comments", "/f/home/index.html", "/f/home/hero.png", "/f/tokens.css"]) {
      expect((await f.get(path)).status).toBe(404);
    }
    const write = await f.get("/comments", {
      method: "POST", headers: { "Content-Type": "application/json", "X-PPM-Request": "1", "X-PPM-Guest-Key": "k".repeat(43) },
      body: JSON.stringify({ body: "x", name: "Ann", anchor: {} }),
    });
    expect(write.status).toBe(404);
  });

  it("answers the invalid page for /s, /s/, a trailing slash and unknown sub-paths", async () => {
    for (const path of ["/s", "/s/", `/s/${f.code}/`, `/s/${f.code}/x/y`, `/s/${f.code}/info/`, "/s/nope"]) {
      const res = await f.app.request(`http://localhost${path}`, { headers: { "Sec-Fetch-Dest": "document" } });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(INVALID_PAGE_HTML);
      expectCommonHeaders(res);
    }
    const put = await f.get("/comments", { method: "PUT" });
    expect(put.status).toBe(404);
  });
});

describe("static route and access log", () => {
  it("404s the built guest page folder from the static route, in any spelling", async () => {
    const f = await makeShareFixture();
    try {
      mkdirSync(join(f.distDir, "design-share-page"), { recursive: true });
      writeFileSync(join(f.distDir, "design-share-page", "index.html"), "<p>raw</p>");
      writeFileSync(join(f.distDir, "index.html"), "<p>shell</p>");
      const app = new Hono();
      app.get("*", createStaticHandler(f.distDir));
      for (const path of ["/design-share-page/index.html", "//design-share-page/index.html", "/Design-Share-Page/index.html"]) {
        const res = await app.request(`http://localhost${path}`);
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain("raw");
      }
    } finally {
      f.restore();
    }
  });

  it("never writes a share code into the access log", () => {
    const code = "C".repeat(43);
    for (const path of [`/s/${code}`, `/s/${code}/f/home/index.html`, `/s/${code}/comments`]) {
      const logged = describeRequestTarget(new URL(`http://localhost${path}?n=abc`));
      expect(logged).not.toContain(code);
      expect(logged.startsWith("/s/[token]")).toBe(true);
    }
  });
});
