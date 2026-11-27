/**
 * PPM's password is asked again before every secret leaves the machine (database connections,
 * Codex logins) and before the password itself changes, and wrong guesses are capped: after
 * `PPM_PASSWORD_MAX_FAILURES` in a row every check is refused for a while, the right one too.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { configService } from "../../../src/services/config.service.ts";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import {
  _resetPpmPasswordAttempts, checkPpmPassword, PPM_PASSWORD_LOCK_MS, PPM_PASSWORD_MAX_FAILURES, ppmPasswordRefusal,
} from "../../../src/services/ppm-password.ts";
import { isPpmPasswordLockedText } from "../../../src/shared/ppm-password-limit.ts";
import { settingsRoutes } from "../../../src/server/routes/settings.ts";
import { databaseRoutes } from "../../../src/server/routes/database.ts";
import { codexAccountsRoutes } from "../../../src/server/routes/codex-accounts.ts";

const app = new Hono()
  .route("/api/settings", settingsRoutes)
  .route("/api/db", databaseRoutes)
  .route("/api/codex-accounts", codexAccountsRoutes);

async function call(method: string, path: string, body: unknown) {
  const res = await app.request(`http://localhost${path}`, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

const authBefore = configService.get("auth");
beforeEach(() => {
  _resetPpmPasswordAttempts();
  configService.set("auth", { ...authBefore, enabled: true, token: "ppm-pass" });
});
afterAll(() => {
  _resetPpmPasswordAttempts();
  configService.set("auth", authBefore);
});

describe("the wrong-guess cap", () => {
  it("refuses even the right password once the guesses run out, until the lock ends", () => {
    const t = 1_000_000;
    for (let i = 0; i < PPM_PASSWORD_MAX_FAILURES; i++) expect(checkPpmPassword("nope", t)).toBe(false);
    expect(checkPpmPassword("ppm-pass", t + 1)).toBe(false);
    const refusal = ppmPasswordRefusal("ppm-pass", t + 1);
    expect(refusal?.status).toBe(429);
    expect(isPpmPasswordLockedText(refusal?.error)).toBe(true);
    expect(checkPpmPassword("ppm-pass", t + PPM_PASSWORD_LOCK_MS)).toBe(true);
  });

  it("counts wrong guesses in a row only: a right one starts the count again", () => {
    for (let i = 0; i < PPM_PASSWORD_MAX_FAILURES - 1; i++) expect(checkPpmPassword("nope")).toBe(false);
    expect(checkPpmPassword("ppm-pass")).toBe(true);
    for (let i = 0; i < PPM_PASSWORD_MAX_FAILURES - 1; i++) expect(checkPpmPassword("nope")).toBe(false);
    expect(checkPpmPassword("ppm-pass")).toBe(true);
  });

  it("says wrong, not locked, before the guesses run out", () => {
    expect(ppmPasswordRefusal("nope")).toEqual({ status: 403, error: "Wrong PPM password" });
  });

  it("asks nothing when PPM runs without a password", () => {
    configService.set("auth", { ...authBefore, enabled: false, token: "" });
    expect(ppmPasswordRefusal(undefined)).toBeNull();
  });
});

describe("POST /api/db/connections/export", () => {
  beforeEach(() => setDb(openTestDb()));

  it("refuses a missing or wrong password without a single connection in the answer", async () => {
    await call("POST", "/api/db/connections", {
      type: "sqlite", name: "secret-holder", connectionConfig: { type: "sqlite", path: "/tmp/secret.db" },
    });
    for (const ppmPassword of [undefined, "", "wrong"]) {
      const res = await call("POST", "/api/db/connections/export", { ppmPassword });
      expect(res.status).toBe(403);
      expect(res.text).not.toContain("secret-holder");
    }
    const res = await call("POST", "/api/db/connections/export", { ppmPassword: "ppm-pass" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("secret-holder");
  });

  it("is no longer a GET", async () => {
    const res = await app.request("http://localhost/api/db/connections/export");
    expect(res.status).not.toBe(200);
  });
});

describe("POST /api/codex-accounts/export", () => {
  it("refuses a missing or wrong PPM password, whatever the backup password", async () => {
    for (const ppmPassword of [undefined, "wrong"]) {
      expect((await call("POST", "/api/codex-accounts/export", { password: "backup", ppmPassword })).status).toBe(403);
    }
    expect((await call("POST", "/api/codex-accounts/export", { password: "backup", ppmPassword: "ppm-pass" })).status).toBe(200);
  });
});

describe("PUT /api/settings/auth/password", () => {
  it("keeps the password unless the current one is typed", async () => {
    for (const current of [undefined, "wrong"]) {
      const res = await call("PUT", "/api/settings/auth/password", { password: "new-pass", confirm: "new-pass", current });
      expect(res.status).toBe(403);
      expect(configService.get("auth").token).toBe("ppm-pass");
    }
    const res = await call("PUT", "/api/settings/auth/password", { password: "new-pass", confirm: "new-pass", current: "ppm-pass" });
    expect(res.status).toBe(200);
    expect(configService.get("auth").token).toBe("new-pass");
  });

  it("answers 429 once the guesses run out", async () => {
    let last = 0;
    for (let i = 0; i <= PPM_PASSWORD_MAX_FAILURES; i++) {
      last = (await call("PUT", "/api/settings/auth/password", { password: "new-pass", confirm: "new-pass", current: "wrong" })).status;
    }
    expect(last).toBe(429);
    expect(configService.get("auth").token).toBe("ppm-pass");
  });
});
