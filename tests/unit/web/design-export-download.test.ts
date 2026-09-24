import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";

/**
 * An exported file is AI-authored HTML (or a zip of it). Saved from a Blob, that Blob must be
 * octet-stream — a `blob:` URL carries PPM's origin, and a browser that navigates to it
 * instead of downloading would run the page next to PPM's token — and its URL must be revoked
 * straight away. The menu's new-tab links use the same `noopener noreferrer`, checked in the
 * browser because they are rendered markup.
 */

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { EXPORT_BLOB_TYPE, NEW_TAB_REL, fetchDesignExport, saveBlobAsFile } =
  await import("../../../src/web/lib/design/design-export-client");

let win: Window;
let clicked: Array<{ href: string; download: string; rel: string; target: string }>;
let created: Blob[];
let revoked: string[];
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
const realFetch = globalThis.fetch;

beforeEach(() => {
  win = new Window({ url: "http://localhost:8080/" });
  clicked = [];
  created = [];
  revoked = [];
  win.document.addEventListener("click", (e) => {
    const a = e.target as unknown as HTMLAnchorElement;
    clicked.push({ href: a.getAttribute("href") ?? "", download: a.download, rel: a.rel, target: a.target });
    e.preventDefault();
  });
  URL.createObjectURL = ((blob: Blob) => { created.push(blob); return `blob:http://localhost:8080/${created.length}`; }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => { revoked.push(url); }) as typeof URL.revokeObjectURL;
});
afterEach(async () => {
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
  globalThis.fetch = realFetch;
  await win.happyDOM.close();
});

const doc = () => win.document as unknown as Document;

describe("saveBlobAsFile", () => {
  it("re-types an HTML blob as octet-stream, clicks a noopener download anchor and revokes the URL", async () => {
    saveBlobAsFile(new Blob(["<script>alert(1)</script>"], { type: "text/html" }), "home.html", doc());
    expect(created).toHaveLength(1);
    expect(created[0]!.type).toBe(EXPORT_BLOB_TYPE);
    expect(clicked).toEqual([{ href: "blob:http://localhost:8080/1", download: "home.html", rel: NEW_TAB_REL, target: "" }]);
    expect(NEW_TAB_REL).toBe("noopener noreferrer");
    // Nothing of the anchor is left in the document to be clicked again.
    expect(win.document.querySelectorAll("a")).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 5));
    expect(revoked).toEqual(["blob:http://localhost:8080/1"]);
  });
});

describe("fetchDesignExport", () => {
  it("sends the auth header and hands back an octet-stream Blob with the server's name and warnings", async () => {
    store.set("ppm-auth-token", "tok-123");
    let seen: { url: string; auth: string | null } | null = null;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen = { url, auth: new Headers(init?.headers).get("Authorization") };
      return new Response("<p>x</p>", {
        headers: {
          "Content-Type": "text/html", "Content-Disposition": 'attachment; filename="home-about.html"',
          "X-PPM-Export-Warnings": "3", "X-PPM-Export-Warning-List": encodeURIComponent(JSON.stringify(["a", "b"])),
        },
      });
    }) as typeof fetch;
    const file = await fetchDesignExport("my project", "home", "html", "pages/about.html");
    expect(seen).toEqual({ url: "/api/project/my%20project/designs/home/export/html?entry=pages%2Fabout.html", auth: "Bearer tok-123" });
    expect(file.blob.type).toBe(EXPORT_BLOB_TYPE);
    expect(file).toMatchObject({ filename: "home-about.html", warnings: ["a", "b"], warningCount: 3 });
  });

  it("falls back to a safe name and surfaces the server's error", async () => {
    globalThis.fetch = (async () => new Response("zip", { headers: { "Content-Disposition": 'attachment; filename="../../evil.sh"' } })) as unknown as typeof fetch;
    expect((await fetchDesignExport("p", "home", "zip")).filename).toBe("home.zip");
    globalThis.fetch = (async () => Response.json({ ok: false, error: "Design is too large to export as a zip" }, { status: 413 })) as unknown as typeof fetch;
    await expect(fetchDesignExport("p", "home", "zip")).rejects.toThrow("too large");
  });
});
