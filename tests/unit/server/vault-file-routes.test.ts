/**
 * `/api/vault` file routes: an upload behind the tier's password (or this page's Secure unlock),
 * the decrypted file answered to that page only (never cached, never sniffed, sandboxed), a wrong
 * password counted like any other, and the type and size limits enforced on the server.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { rmSync } from "node:fs";
import { getDb, getDbPath } from "../../../src/services/db.service.ts";
import { vaultRoutes } from "../../../src/server/routes/vault.ts";
import { vaultService } from "../../../src/services/vault/vault.service.ts";
import { vaultGrants } from "../../../src/services/vault/vault-grants.ts";
import { vaultFilesDirFor } from "../../../src/services/vault/vault-files-dir.ts";
import { VAULT_FILE_MAX_BYTES } from "../../../src/shared/vault.ts";

const app = new Hono().route("/api/vault", vaultRoutes);
const MK2 = "secure-pass-route-01";
const MK3 = "sealed-password-route-01";
const HANDLE = "h".repeat(48);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("CANARY-ROUTE-BYTES")]);

const json = (path: string, body: unknown, method = "POST") =>
  app.request(`/api/vault${path}`, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });

/** A multipart upload as a browser sends it: with its length declared, which the route requires. */
async function upload(itemId: string, bytes: Uint8Array, fields: Record<string, string>, name = "scan.jpg") {
  const form = new FormData();
  form.set("file", new File([bytes], name));
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const req = new Request(`http://local/api/vault/items/${itemId}/files`, { method: "POST", body: form });
  req.headers.set("content-length", String((await req.clone().arrayBuffer()).byteLength));
  return app.request(req);
}

it("refuses an upload that does not declare its length", async () => {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([0xff, 0xd8, 0xff])], "a.jpg"));
  const res = await app.request(`/api/vault/items/${secureItem}/files`, { method: "POST", body: form });
  expect(res.status).toBe(411);
});

let secureItem = "";
let sealedItem = "";

beforeEach(async () => {
  vaultGrants.lock();
  getDb().exec("DELETE FROM vault_attachments; DELETE FROM vault_items; DELETE FROM vault_keys;");
  rmSync(vaultFilesDirFor(getDbPath()), { recursive: true, force: true });
  await vaultService.enableTier("secure", MK2);
  await vaultService.enableTier("sealed", MK3);
  const s = await vaultService.unlock("secure", MK2);
  const z = await vaultService.unlock("sealed", MK3);
  if (!s.ok || !z.ok) throw new Error("unlock");
  secureItem = vaultService.addItem({ tier: "secure", name: "NI", kind: "ni_number", value: "QQ123456C" }, s.dek).id;
  sealedItem = vaultService.addItem({ tier: "sealed", name: "Passport", kind: "passport", value: "AB1234567" }, z.dek).id;
});

describe("vault file routes", () => {
  it("asks for the password, then uploads and answers the file with safe headers", async () => {
    expect((await upload(secureItem, jpeg, { handle: HANDLE })).status).toBe(423);
    const up = await upload(secureItem, jpeg, { handle: HANDLE, password: MK2, label: "Front" });
    expect(up.status).toBe(200);
    const meta = ((await up.json()) as { data: { id: string; label: string; type: string } }).data;
    expect(meta).toMatchObject({ label: "Front", type: "image/jpeg" });
    // The page's Secure unlock now answers without the password; nothing else does.
    expect((await json(`/files/${meta.id}/content`, {})).status).toBe(423);
    const res = await json(`/files/${meta.id}/content`, { handle: HANDLE });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''scan.jpg");
    expect(Buffer.from(await res.arrayBuffer()).equals(jpeg)).toBe(true);
    const dl = await json(`/files/${meta.id}/content`, { handle: HANDLE, download: true });
    expect(dl.headers.get("content-disposition")).toStartWith("attachment;");
    // The listing carries label, type and size only.
    const listed = await (await app.request("/api/vault/items")).text();
    expect(listed).toContain("Front");
    expect(listed).not.toContain("scan.jpg");
  });

  it("asks a Sealed file for its password every time, and counts a wrong one", async () => {
    const up = await upload(sealedItem, jpeg, { handle: HANDLE, password: MK3 });
    const id = ((await up.json()) as { data: { id: string } }).data.id;
    expect((await json(`/files/${id}/content`, { handle: HANDLE })).status).toBe(423);
    const wrong = await json(`/files/${id}/content`, { handle: HANDLE, password: "not-the-password-x" });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { attemptsLeft?: number }).attemptsLeft).toBeNumber();
    expect((await json(`/files/${id}/content`, { handle: HANDLE, password: MK3 })).status).toBe(200);
  });

  it("refuses SVG, an oversized file and a public item, and renames and deletes", async () => {
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    expect((await upload(secureItem, svg, { handle: HANDLE, password: MK2 }, "x.svg")).status).toBe(400);
    const big = new Uint8Array(VAULT_FILE_MAX_BYTES + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect((await upload(secureItem, big, { handle: HANDLE, password: MK2 })).status).toBe(413);
    const pub = vaultService.addItem({ tier: "public", name: "City", kind: "address", value: "Leith" });
    expect((await upload(pub.id, jpeg, { handle: HANDLE })).status).toBe(400);
    const up = await upload(secureItem, jpeg, { handle: HANDLE, password: MK2 });
    const id = ((await up.json()) as { data: { id: string } }).data.id;
    const renamed = await json(`/files/${id}`, { handle: HANDLE, label: "Back" }, "PATCH");
    expect(((await renamed.json()) as { data: { label: string } }).data.label).toBe("Back");
    expect((await json(`/files/${id}/delete`, { handle: HANDLE })).status).toBe(200);
    expect((await json(`/files/${id}/content`, { handle: HANDLE })).status).toBe(404);
  });
});
