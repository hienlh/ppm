/**
 * `GET /api/card-files/<id>`: a picture, video or PDF served as itself (inline, or as an
 * attachment on `?download=1`), anything else as `application/octet-stream` attachment, never
 * runnable as a page (`nosniff`, CSP `sandbox`), and 404 for an unknown or malformed id.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardFileRoutes } from "../../../src/server/routes/card-files.ts";
import { removeCardFile, storeCardFile, type StoredCardFile } from "../../../src/services/assistant-cards/card-files-store.ts";

let dir: string;
let pdf: StoredCardFile;
let html: StoredCardFile;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "card-files-route-"));
  writeFileSync(join(dir, "spec.pdf"), "%PDF-1.7 body");
  writeFileSync(join(dir, "Báo cáo.html"), "<html><script>alert(1)</script></html>");
  pdf = await storeCardFile(join(dir, "spec.pdf"), "spec.pdf", dir);
  html = await storeCardFile(join(dir, "Báo cáo.html"), "Báo cáo.html", dir);
});
afterAll(async () => {
  await removeCardFile(pdf.id);
  await removeCardFile(html.id);
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/card-files/<id>", () => {
  it("serves a PDF inline as itself, or as an attachment on request", async () => {
    const res = await cardFileRoutes.request(`/${pdf.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toStartWith("inline;");
    expect(await res.text()).toBe("%PDF-1.7 body");
    const dl = await cardFileRoutes.request(`/${pdf.id}?download=1`);
    expect(dl.headers.get("content-disposition")).toStartWith("attachment;");
  });

  it("serves anything else as an octet-stream attachment that can never run as a page", async () => {
    const res = await cardFileRoutes.request(`/${html.id}`);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain("attachment;");
    expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''B%C3%A1o%20c%C3%A1o.html");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("answers a byte range with 206, so a video starts at once and seeks with one small request", async () => {
    const whole = await cardFileRoutes.request(`/${pdf.id}`);
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(whole.headers.get("content-length")).toBe(String("%PDF-1.7 body".length));
    const part = await cardFileRoutes.request(`/${pdf.id}`, { headers: { Range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 2-5/${"%PDF-1.7 body".length}`);
    expect(await part.text()).toBe("DF-1");
    expect(part.headers.get("content-type")).toBe("application/pdf");
  });

  it("tells the viewer what the file is, and nothing about where it came from", async () => {
    const res = await cardFileRoutes.request(`/${pdf.id}/info`);
    const body = await res.json() as { ok: boolean; data: { file: Record<string, unknown> } };
    expect(body.ok).toBe(true);
    expect(body.data.file).toMatchObject({ id: pdf.id, name: "spec.pdf", kind: "pdf" });
    expect(body.data.file.projectPath).toBeUndefined();
    expect((await cardFileRoutes.request(`/${"f".repeat(32)}/info`)).status).toBe(404);
  });

  it("answers 404 for an unknown or malformed id", async () => {
    expect((await cardFileRoutes.request(`/${"f".repeat(32)}`)).status).toBe(404);
    expect((await cardFileRoutes.request("/..%2Fppm.db")).status).toBe(404);
    expect((await cardFileRoutes.request("/ABC")).status).toBe(404);
  });
});
