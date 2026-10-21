import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { guestHeaders, guestKey, makeShareFixture, type ShareFixture } from "./design-share-guest-fixture.ts";

/**
 * A reviewer chooses the anchor's file, so a file that is not in the shared version is their
 * mistake, not the server's: a 4xx, logged as a warning that names no path on the host.
 */

describe("design share guest refusals in the log", () => {
  let f: ShareFixture;
  beforeEach(async () => { f = await makeShareFixture(); });
  afterEach(() => f.restore());

  it("answers an anchor on a file the version does not have with a 4xx and no host path in the log", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const files = ["missing.html", "sub/missing.html", "assets/not-a-page.htm"];
      for (const [i, file] of files.entries()) {
        const res = await f.get("/comments", {
          method: "POST", headers: guestHeaders(guestKey(`k${i}`)),
          body: JSON.stringify({
            anchor: { file, ppmId: null, gen: null, tag: "p", cssPath: "", quote: { exact: "x", prefix: "", suffix: "" } },
            body: "hi", name: "Ann", versionId: f.link.snapshotId,
          }),
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(JSON.stringify(await res.json())).not.toContain(f.project);
      }
      expect(error).not.toHaveBeenCalled();
      const logged = warn.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(logged).not.toContain(f.project);
      expect(logged).not.toMatch(/[A-Za-z]:\\|\/tmp\/|\/home\//);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });
});
