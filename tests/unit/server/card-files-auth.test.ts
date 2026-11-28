/**
 * A report card's file is played by `<video src>`, which cannot send a header, so the bytes route
 * takes the session token as `?token=`. Only that route, and only for an id-shaped name: `/info`
 * and every other route still need the header, and a wrong token is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { authMiddleware } from "../../../src/server/middleware/auth.ts";
import { configService } from "../../../src/services/config.service.ts";

const TOKEN = "test-token-card-files";
const ID = "a".repeat(32);
let saved: unknown;

const app = new Hono();
app.use("*", authMiddleware);
app.get("*", (c) => c.text("ok"));

beforeAll(() => {
  saved = structuredClone(configService.get("auth"));
  const auth = (configService as unknown as { config: { auth: { enabled: boolean; token: string } } }).config.auth;
  auth.enabled = true;
  auth.token = TOKEN;
});
afterAll(() => {
  Object.assign((configService as unknown as { config: { auth: object } }).config.auth, saved);
});

const status = async (path: string) => (await app.request(path)).status;

describe("?token= on card files", () => {
  it("is taken on the bytes route of an id", async () => {
    expect(await status(`/api/card-files/${ID}?token=${TOKEN}`)).toBe(200);
    expect(await status(`/api/card-files/${ID}?download=1&token=${TOKEN}`)).toBe(200);
  });

  it("is not taken with a wrong token, on /info, on a path-shaped name or on another route", async () => {
    expect(await status(`/api/card-files/${ID}?token=wrong`)).toBe(401);
    expect(await status(`/api/card-files/${ID}/info?token=${TOKEN}`)).toBe(401);
    expect(await status(`/api/card-files/..%2Fppm.db?token=${TOKEN}`)).toBe(401);
    expect(await status(`/api/assistant/cards/open?token=${TOKEN}`)).toBe(401);
  });
});
