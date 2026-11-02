import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GUEST_BRIDGE_JS } from "../../../src/services/design/bridge/guest-bridge.ts";
import { BRIDGE_JS } from "../../../src/services/design/bridge/bridge-script.ts";
import { shareRateClock } from "../../../src/services/design/share/design-share-rate-limit.ts";
import { makeShareFixture, type ShareFixture } from "./design-share-guest-fixture.ts";

const NONCE = "abcdefghijklmnop";

describe("design share guest files", () => {
  let f: ShareFixture;
  beforeEach(async () => { f = await makeShareFixture({ system: "acme" }); });
  afterEach(() => f.restore());

  it("serves the pinned snapshot, not the live file, with ids and the reviewer's bridge", async () => {
    writeFileSync(join(f.designs, "home", "index.html"), "<p>live edit after the pin</p>");
    const res = await f.get(`/f/home/index.html?n=${NONCE}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Pinned");
    expect(html).not.toContain("live edit");
    expect(html).toContain("data-ppm-id");
    expect(html).toContain(GUEST_BRIDGE_JS);
    expect(html).not.toContain(BRIDGE_JS);
    expect(html).toContain(`data-nonce="${NONCE}"`);
    // No stylesheet gens: they would be read from the live folder.
    expect(html).toContain('data-css-gens="{}"');
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toStartWith("sandbox allow-scripts;");
    expect(csp).toContain(`connect-src https://localhost/s/${f.code}/f/ http://localhost/s/${f.code}/f/`);
    expect(csp).not.toContain("allow-modals");
    expect(res.headers.get("access-control-allow-origin")).toBe("null");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("serves snapshot assets with Range, exactly the bytes asked for", async () => {
    const whole = await f.get("/f/home/hero.png");
    expect(await whole.text()).toBe("0123456789");
    const part = await f.get("/f/home/hero.png", { headers: { Range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-length")).toBe("4");
    expect(await part.text()).toBe("2345");
    expect(part.headers.get("access-control-allow-origin")).toBe("null");
  });

  it("refuses another design, traversal, encoded separators and the comment file", async () => {
    for (const path of [
      "/f/other/index.html", "/f/home/..%2F..%2Fother%2Findex.html", "/f/home%2F..%2Fother%2Findex.html",
      "/f/home/.design/comments.json", "/f/home/%2Edesign/comments.json", "/f/home/design.json%00.png",
    ]) {
      const res = await f.get(path);
      expect([403, 404]).toContain(res.status);
      expect(await res.text()).not.toContain("other design");
    }
    // `..` resolved by the URL parser lands outside the link's prefix: never served.
    const dotted = await f.app.request(`http://localhost/s/${f.code}/f/home/../../other/index.html`);
    expect(dotted.status).toBe(404);
    expect(await dotted.text()).not.toContain("other design");
  });

  it("serves the shared tokens and this design's own app kit, live, and nothing else", async () => {
    const acme = join(f.designs, "systems", "acme");
    mkdirSync(join(acme, "kit"), { recursive: true });
    writeFileSync(join(acme, "tokens.css"), ":root{--acme:1}");
    writeFileSync(join(acme, "kit", "x.css"), ".x{}");
    writeFileSync(join(acme, "system.json"), "{}");
    mkdirSync(join(f.designs, "systems", "other-app", "kit"), { recursive: true });
    writeFileSync(join(f.designs, "systems", "other-app", "tokens.css"), ":root{}");

    expect(await (await f.get("/f/tokens.css")).text()).toContain("--accent");
    expect(await (await f.get("/f/systems/acme/tokens.css")).text()).toContain("--acme");
    expect((await f.get("/f/systems/acme/kit/x.css")).status).toBe(200);
    for (const path of [
      "/f/systems/acme/system.json", "/f/systems/other-app/tokens.css",
      "/f/systems/default/other/index.html", "/f/systems/default/home/index.html", "/f/systems/default/tokens.css",
      "/f/systems", "/f/systems/acme",
    ]) {
      expect((await f.get(path)).status).toBe(403);
    }
  });

  it("loads a 100-file design for ten reviewers sharing the local key without a 429", async () => {
    const realNow = shareRateClock.now;
    let now = 5_000_000;
    shareRateClock.now = () => now;
    try {
      for (let reviewer = 0; reviewer < 10; reviewer++) {
        for (const path of ["", "/info", "/comments"]) expect((await f.get(path)).status).not.toBe(429);
        for (let i = 0; i < 100; i++) {
          now += 5;
          expect((await f.get(i === 0 ? "/f/home/index.html" : "/f/home/hero.png")).status).toBe(200);
        }
      }
    } finally {
      shareRateClock.now = realNow;
    }
  });

  it("does not let API polls use up the file budget", async () => {
    for (let i = 0; i < 130; i++) await f.get("/comments");
    expect((await f.get("/comments")).status).toBe(429);
    expect((await f.get("/f/home/hero.png")).status).toBe(200);
  });
});
