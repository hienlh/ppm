import { Hono } from "hono";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configService } from "../../../src/services/config.service.ts";
import { getDb } from "../../../src/services/db.service.ts";
import { createDesign } from "../../../src/services/design/design-store.service.ts";
import { createShareLink } from "../../../src/services/design/share/design-share-links.service.ts";
import { resetShareRateLimits, shareRateClock } from "../../../src/services/design/share/design-share-rate-limit.ts";
import { createDesignShareGuestRoutes } from "../../../src/server/routes/design-share-guest.ts";
import { designShareNotifier, type GuestWrite } from "../../../src/services/design/share/design-share-notifier.ts";
import type { DesignShareLink } from "../../../src/shared/design-share-types.ts";

/**
 * A project with two designs (`home`, shared, and `other`), the shared `tokens.css`, and one
 * share link on `home` pinned to a snapshot taken after the files below were written. The
 * guest routes are mounted at `/s` exactly as the server mounts them.
 */

export const SNAPSHOT_INDEX = "<!doctype html><html><head><link rel=\"stylesheet\" href=\"styles.css\">"
  + "<link rel=\"stylesheet\" href=\"../tokens.css\"></head><body><h1>Pinned</h1><p>text</p></body></html>";

export interface ShareFixture {
  project: string;
  designs: string;
  app: Hono;
  link: DesignShareLink;
  code: string;
  distDir: string;
  /**
   * What the routes handed the owner's notifier. Recorded instead of sent, so no notification
   * timer outlives the test and fires into another file's channel stand-ins.
   */
  notes: GuestWrite[];
  /** `fetch` against the mounted app; `path` is relative to `/s/<code>`. */
  get(path?: string, init?: RequestInit): Promise<Response>;
  restore(): void;
}

export async function makeShareFixture(opts: { system?: string } = {}): Promise<ShareFixture> {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-share-guest-")));
  const previousAuth = { ...configService.get("auth") };
  const previousProjects = [...configService.get("projects")];
  configService.set("auth", { ...previousAuth, enabled: true, token: "share-guest-test" });
  configService.set("projects", [{ name: "demo", path: project }]);
  getDb().exec("DELETE FROM design_share_links");
  resetShareRateLimits();
  const realNow = shareRateClock.now;
  const realNote = designShareNotifier.noteGuestWrite;
  const notes: GuestWrite[] = [];
  designShareNotifier.noteGuestWrite = async (_resolved, write) => { notes.push(write); };

  await createDesign(project, { title: "Home", kind: "page" });
  const designs = join(project, "designs");
  const home = join(designs, "home");
  writeFileSync(join(home, "index.html"), SNAPSHOT_INDEX);
  writeFileSync(join(home, "styles.css"), "h1{color:red}");
  writeFileSync(join(home, "hero.png"), "0123456789");
  const manifest = JSON.parse(readFileSync(join(home, "design.json"), "utf8"));
  writeFileSync(join(home, "design.json"), JSON.stringify({ ...manifest, ...(opts.system ? { system: opts.system } : {}) }));
  mkdirSync(join(designs, "other"), { recursive: true });
  writeFileSync(join(designs, "other", "index.html"), "<p>other design</p>");
  writeFileSync(join(designs, "tokens.css"), ":root{--accent:#f00}");

  const link = await createShareLink(project, "home", { label: "Client", expiresAt: null, version: "current" });
  const code = link.path!.slice("/s/".length);
  const distDir = join(project, "dist-web");
  const app = new Hono();
  app.route("/s", createDesignShareGuestRoutes({ distDir }));
  return {
    project, designs, app, link, code, distDir, notes,
    get: (path = "", init) => app.request(`http://localhost/s/${code}${path}`, init),
    restore() {
      shareRateClock.now = realNow;
      designShareNotifier.noteGuestWrite = realNote;
      resetShareRateLimits();
      configService.set("auth", previousAuth);
      configService.set("projects", previousProjects);
      rmSync(project, { recursive: true, force: true });
    },
  };
}

/** Headers of a reviewer's write: the cross-origin pair and the browser key. */
export function guestHeaders(key: string): Record<string, string> {
  return { "Content-Type": "application/json", "X-PPM-Request": "1", "X-PPM-Guest-Key": key };
}

/** A well-formed browser key, distinct per `seed`. */
export function guestKey(seed: string): string {
  return seed.repeat(43).slice(0, 43).replace(/[^A-Za-z0-9_-]/g, "a");
}
