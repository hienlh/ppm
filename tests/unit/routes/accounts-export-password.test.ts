import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { configService } from "../../../src/services/config.service.ts";
import { accountService } from "../../../src/services/account.service.ts";
import { encryptWithPassword } from "../../../src/lib/account-crypto.ts";
import { accountsRoutes } from "../../../src/server/routes/accounts.ts";

// Both routes that let account tokens leave the machine must ask for PPM's password.

const originals = {
  exportEncrypted: accountService.exportEncrypted,
  refreshBeforeExport: accountService.refreshBeforeExport,
  getWithTokens: accountService.getWithTokens,
};
let exported: string[][];
accountService.refreshBeforeExport = async () => {};
accountService.exportEncrypted = ((password: string, ids?: string[]) => {
  exported.push(ids ?? []);
  const rows = (ids ?? []).map((id) => ({ id, label: "a", email: "a@x", access_token: "sk-ant-secret-token", expires_at: null }));
  return encryptWithPassword(JSON.stringify(rows), password);
}) as typeof accountService.exportEncrypted;
accountService.getWithTokens = ((id: string) => ({ id, label: "a", email: "a@x", accessToken: "sk-ant-secret-token", expiresAt: null })) as never;

const post = (path: string, body: unknown) =>
  new Hono().route("/api/accounts", accountsRoutes).request(`http://localhost/api/accounts${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

let authBefore: ReturnType<typeof configService.get<"auth">>;
beforeEach(() => {
  exported = [];
  authBefore ??= configService.get("auth");
  configService.set("auth", { ...authBefore, enabled: true, token: "ppm-pass" });
});
afterAll(() => {
  configService.set("auth", authBefore);
  Object.assign(accountService, originals);
});

describe("account export asks for PPM's password", () => {
  for (const [path, body] of [
    ["/export", { password: "backup-pass", accountIds: ["acc1"] }],
    ["/test-export", { accountIds: ["acc1"] }],
  ] as const) {
    it(`${path} refuses a missing or wrong password and exports nothing`, async () => {
      for (const ppmPassword of [undefined, "", "wrong"]) {
        const res = await post(path, { ...body, ppmPassword });
        expect(res.status).toBe(403);
        expect(await res.text()).not.toContain("sk-ant-secret-token");
      }
      expect(exported).toEqual([]);
    });

    it(`${path} exports with the right password`, async () => {
      const res = await post(path, { ...body, ppmPassword: "ppm-pass" });
      expect(res.status).toBe(200);
      expect(exported).toEqual([["acc1"]]);
    });

    it(`${path} needs no password when PPM runs without one`, async () => {
      configService.set("auth", { ...authBefore, enabled: false, token: "" });
      const res = await post(path, body);
      expect(res.status).toBe(200);
    });
  }
});
