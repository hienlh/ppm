import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectScopedRouter } from "../../../src/server/routes/project-scoped.ts";
import { authMiddleware } from "../../../src/server/middleware/auth.ts";
import { configService } from "../../../src/services/config.service.ts";
import { createDesign } from "../../../src/services/design/design-store.service.ts";
import { computeGen } from "../../../src/services/design/source/design-source-file.ts";
import { snapshotDesign } from "../../../src/services/design/design-snapshots.service.ts";
import { addComment } from "../../../src/services/design/design-comments.service.ts";
import { createShareLink } from "../../../src/services/design/share/design-share-links.service.ts";

const PAGE = "<!doctype html><html><body><main><h1>Welcome</h1><p>Pricing starts at $9 a month</p></main></body></html>";

describe("design comment routes", () => {
  let project: string;
  let app: Hono;
  let previousAuth: ReturnType<typeof configService.get<"auth">>;
  let previousProjects: ReturnType<typeof configService.get<"projects">>;

  const call = (path: string, init: RequestInit = {}, auth = true) => app.request(`http://localhost/api/project/demo/designs/home/comments${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: "Bearer design-test" } : {}), ...(init.headers ?? {}) },
  });
  const anchor = () => ({
    file: "index.html", ppmId: PAGE.indexOf("<p>"), gen: computeGen(PAGE), tag: "p", cssPath: "body > main:nth-of-type(1) > p:nth-of-type(1)",
    quote: { exact: "Pricing starts at $9 a month", prefix: "Welcome", suffix: "" },
  });
  const post = (body: unknown, path = "") => call(path, { method: "POST", body: JSON.stringify(body) });

  beforeEach(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-comment-routes-")));
    await createDesign(project, { title: "Home", kind: "page" });
    writeFileSync(join(project, "designs", "home", "index.html"), PAGE);
    app = new Hono();
    app.use("/api/*", authMiddleware);
    app.route("/api/project/:projectName", projectScopedRouter);
    previousAuth = { ...configService.get("auth") };
    previousProjects = [...configService.get("projects")];
    configService.set("auth", { ...previousAuth, enabled: true, token: "design-test" });
    configService.set("projects", [{ name: "demo", path: project }]);
  });
  afterEach(() => {
    configService.set("auth", previousAuth);
    configService.set("projects", previousProjects);
    rmSync(project, { recursive: true, force: true });
  });

  it("requires authentication", async () => {
    expect((await call("", {}, false)).status).toBe(401);
    expect((await call("", { method: "POST", body: "{}" }, false)).status).toBe(401);
  });

  it("creates, lists, updates and deletes in the standard envelope", async () => {
    const created = await post({ anchor: anchor(), body: "Bolder" });
    expect(created.status).toBe(201);
    const { data: comment } = await created.json();
    expect(comment).toMatchObject({ body: "Bolder", file: "index.html", snippet: "<p>Pricing starts at $9 a month</p>" });

    const listed = await (await call("")).json();
    expect(listed).toMatchObject({ ok: true, data: [{ id: comment.id }] });

    const patched = await call(`/${comment.id}`, { method: "PATCH", body: JSON.stringify({ resolved: true }) });
    expect((await patched.json()).data.resolvedAt).toBeTruthy();

    expect((await call(`/${comment.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await (await call("")).json()).data).toEqual([]);
    expect((await call(`/${comment.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("answers the server-built context for one element without saving", async () => {
    const res = await post({ anchor: anchor() }, "/context");
    expect(await res.json()).toEqual({
      ok: true,
      data: { snippet: "<p>Pricing starts at $9 a month</p>", quote: { exact: "Pricing starts at $9 a month", prefix: "Welcome", suffix: "" } },
    });
    expect((await (await call("")).json()).data).toEqual([]);
  });

  it("rejects bad input and unknown targets", async () => {
    expect((await call("", { method: "POST", body: "not json" })).status).toBe(400);
    expect((await post({ anchor: { ...anchor(), file: "../x.html" }, body: "x" })).status).toBe(400);
    expect((await call("/abcdefabcdef", { method: "PATCH", body: JSON.stringify({ resolved: true }) })).status).toBe(404);
    const other = await app.request("http://localhost/api/project/demo/designs/nope/comments", { headers: { Authorization: "Bearer design-test" } });
    expect(other.status).toBe(404);
  });

  it("answers the owner's view of threads, with replies, and never a reviewer's key", async () => {
    const snapshot = (await snapshotDesign(project, "home", "manual")) as { id: string };
    const link = await createShareLink(project, "home", { label: "Client", expiresAt: null, version: snapshot.id });
    const key = "e".repeat(64);
    const guestRoot = await addComment(project, "home", { anchor: anchor(), body: "From Ann" }, {
      actor: { kind: "guest", name: "Ann", linkId: link.id, keyHash: key }, source: { snapshotId: snapshot.id },
    });
    await addComment(project, "home", { anchor: anchor(), body: "Gone link" }, {
      actor: { kind: "guest", name: "Bo", linkId: "999999999999", keyHash: key }, source: { snapshotId: snapshot.id },
    });

    const replied = await post({ body: "Thanks" }, `/${guestRoot.id}/replies`);
    expect(replied.status).toBe(201);
    const thread = (await replied.json()).data;
    expect(thread.author).toEqual({ kind: "guest", name: "Ann", linkId: link.id, linkLabel: "Client" });
    expect(thread.replies).toMatchObject([{ body: "Thanks", author: { kind: "owner" } }]);
    const replyId = thread.replies[0].id;

    const edited = await call(`/${guestRoot.id}/replies/${replyId}`, { method: "PATCH", body: JSON.stringify({ body: "Thanks!" }) });
    expect((await edited.json()).data.replies[0].body).toBe("Thanks!");

    const listedRes = await call("");
    const listedText = await listedRes.text();
    expect(listedText).not.toContain(key);
    expect(listedText).not.toContain("keyHash");
    const listed = JSON.parse(listedText).data as { body: string; author: { linkLabel?: string } }[];
    expect(listed.map((c) => [c.body, c.author.linkLabel])).toEqual([["From Ann", "Client"], ["Gone link", "Removed link"]]);

    const rewrite = await call(`/${guestRoot.id}`, { method: "PATCH", body: JSON.stringify({ body: "Owner words" }) });
    expect(rewrite.status).toBe(403);
    const resolved = await call(`/${guestRoot.id}`, { method: "PATCH", body: JSON.stringify({ resolved: true }) });
    expect(resolved.status).toBe(200);
    expect(await resolved.text()).not.toContain(key);

    expect((await call(`/${guestRoot.id}/replies/${replyId}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(`/${guestRoot.id}/replies/${replyId}`, { method: "DELETE" })).status).toBe(404);
    expect((await post({ body: "" }, `/${guestRoot.id}/replies`)).status).toBe(400);
    expect((await call(`/${guestRoot.id}/replies`, { method: "POST", body: "not json" })).status).toBe(400);
  });

  it("answers 409 to a re-anchor the source does not support", async () => {
    const { data: comment } = await (await post({ anchor: anchor(), body: "x" })).json();
    const res = await call(`/${comment.id}`, { method: "PATCH", body: JSON.stringify({ anchor: { ppmId: PAGE.indexOf("<h1>"), gen: computeGen(PAGE) } }) });
    expect(res.status).toBe(409);
    expect((await res.json()).ok).toBe(false);
  });
});
