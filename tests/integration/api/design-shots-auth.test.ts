/**
 * Design screenshots as the real server mounts them: behind PPM's login like every other route.
 * Telegram receives the pictures themselves, so nothing outside PPM opens this route.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "../../../src/server/index.ts";
import { configService } from "../../../src/services/config.service.ts";
import { shotsDir } from "../../../src/services/design/shots/design-shots.service.ts";

const ID = "f".repeat(32);
const TOKEN = "design-shots-auth-token";

describe("design screenshots in the server", () => {
  const previousAuth = structuredClone(configService.get("auth"));

  beforeAll(() => {
    configService.set("auth", { ...previousAuth, enabled: true, token: TOKEN });
    mkdirSync(shotsDir(), { recursive: true });
    writeFileSync(join(shotsDir(), `${ID}.png`), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    writeFileSync(join(shotsDir(), `${ID}.json`), JSON.stringify({
      id: ID, projectPath: "/p", slug: "kho", designTitle: "Kho", file: "index.html", label: "", width: 1280, height: 900,
      createdAt: new Date().toISOString(),
    }));
  });
  afterAll(() => configService.set("auth", previousAuth));

  it("answers 401 without the token, even for an id that exists", async () => {
    const res = await app.request(`/api/design-shots/${ID}.png`);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type") ?? "").not.toContain("image/png");
    // The query fallback is not opened for this route either.
    expect((await app.request(`/api/design-shots/${ID}.png?token=${TOKEN}`)).status).toBe(401);
  });

  it("serves the picture to a signed-in request", async () => {
    const res = await app.request(`/api/design-shots/${ID}.png`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer()).byteLength).toBe(7);
  });
});
