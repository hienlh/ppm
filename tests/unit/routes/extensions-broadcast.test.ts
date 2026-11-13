/**
 * An extensions write that succeeds tells every open PPM (`extensions:changed`), whoever made it,
 * so a disabled extension's commands leave every open palette. Reads and refused writes announce
 * nothing. The list says which extensions are bundled.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { getExtensionById, insertExtension, openTestDb, setDb } from "../../../src/services/db.service.ts";
import { extensionRoutes } from "../../../src/server/routes/extensions.ts";
import { ANNOUNCE_EXTENSIONS_ENV_KEY } from "../../../src/server/routes/extensions-broadcast.ts";

let announced: number;
const app = new Hono().route("/api/extensions", extensionRoutes);

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(`http://ppm.local/api/extensions${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  }, { [ANNOUNCE_EXTENSIONS_ENV_KEY]: () => { announced++; } });
  return { status: res.status, json: await res.json() as { ok: boolean; data: any; error?: string } };
}

beforeEach(() => {
  setDb(openTestDb());
  announced = 0;
  insertExtension({
    id: "ext-demo", version: "1.0.0", display_name: "Demo", description: null, icon: null, enabled: 1,
    manifest: JSON.stringify({ id: "ext-demo", name: "ext-demo", version: "1.0.0", main: "index.js" }),
  });
});

describe("extensions:changed", () => {
  it("is announced once for a disable that succeeds", async () => {
    const res = await call("PATCH", "/ext-demo", { enabled: false });
    expect(res.status).toBe(200);
    expect(getExtensionById("ext-demo")?.enabled).toBe(0);
    expect(announced).toBe(1);
  });

  it("is never announced for a read or a refused write", async () => {
    const list = await call("GET", "");
    expect(list.json.data.map((e: { id: string; bundled: boolean }) => [e.id, e.bundled])).toEqual([["ext-demo", false]]);
    await call("GET", "/contributions");
    await call("GET", "/ext-demo");
    expect((await call("PATCH", "/ext-demo", {})).status).toBe(400);
    expect((await call("PATCH", "/no-such-ext", { enabled: false })).status).toBe(500);
    expect((await call("POST", "/install", {})).status).toBe(400);
    expect((await call("POST", "/dev-link", {})).status).toBe(400);
    expect(announced).toBe(0);
  });
});
