/**
 * GET /api/upgrade must answer from a live registry check, not only from the
 * version the supervisor recorded — that record lands 5min after startup and
 * every 15min after, so a UI opened inside that window saw no update and
 * rendered no upgrade button.
 *
 * The two signals are also combined by recency, not by rank: whichever names
 * the newer version wins. The server answers its own check from a cache while
 * the supervisor checks uncached on its own timer, so a recorded version can
 * legitimately be newer than the live answer just returned.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { resolve } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import "../../test-setup.ts";

import { VERSION } from "../../../src/version.ts";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import { resolveAvailableVersion } from "../../../src/server/routes/upgrade.ts";

const STATUS_PATH = resolve(getPpmDir(), "status.json");

/** A version one patch newer than the running one. */
const NEWER = (() => {
  const [maj = 0, min = 0, patch = 0] = VERSION.split("-")[0]!.split(".").map(Number);
  return `${maj}.${min}.${patch + 1}`;
})();

function recordVersion(v: string | null) {
  writeFileSync(STATUS_PATH, JSON.stringify({ availableVersion: v }));
}

const offline = async () => null;

beforeEach(() => {
  try { rmSync(STATUS_PATH, { force: true }); } catch {}
});
afterAll(() => {
  try { rmSync(STATUS_PATH, { force: true }); } catch {}
});

describe("resolveAvailableVersion", () => {
  it("offers a newer version from the live check with nothing recorded yet", async () => {
    expect(await resolveAvailableVersion(async () => NEWER)).toBe(NEWER);
  });

  it("falls back to the recorded version when the registry is unreachable", async () => {
    recordVersion(NEWER);
    expect(await resolveAvailableVersion(offline)).toBe(NEWER);
  });

  it("takes the recorded version when the live check is behind it", async () => {
    recordVersion(NEWER);
    expect(await resolveAvailableVersion(async () => VERSION)).toBe(NEWER);
  });

  it("takes the live check when the recorded version is behind it", async () => {
    recordVersion(VERSION);
    expect(await resolveAvailableVersion(async () => NEWER)).toBe(NEWER);
  });

  it("forwards a forced check to the underlying version check", async () => {
    let seen: { force?: boolean } | undefined;
    await resolveAvailableVersion(async (o) => { seen = o; return null; }, { force: true });
    expect(seen?.force).toBe(true);
  });

  it("reports no update when the live version is not newer", async () => {
    expect(await resolveAvailableVersion(async () => VERSION)).toBeNull();
  });

  it("reports no update when neither source has one", async () => {
    expect(await resolveAvailableVersion(offline)).toBeNull();
  });
});
