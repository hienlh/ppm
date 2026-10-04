/**
 * Every answer reaches the request that asked for it.
 *
 * The host handles the panel's messages concurrently, so two requests of one
 * action — Update all on two submodules, a second discard — can finish in
 * either order. The panel kept one queue per action and gave each answer to the
 * oldest request still waiting, so an answer that overtook an older one went to
 * the wrong caller: "Could not update one" carrying the other submodule's error,
 * and then "Updated two". Each request now carries an id its answer echoes.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { envelope, openPanelHost, openPanelPage, type PanelHost, type PanelPage } from "./panel-test-harness.ts";

describe("the host", () => {
  let host: PanelHost;
  afterEach(() => host.close());

  it("echoes each request's id, so an answer that overtakes an older one still names its own request", async () => {
    let releaseFirst = () => {};
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    host = await openPanelHost(async (method, path, body) => {
      if (method !== "POST" || path !== "/discard") return undefined;
      if (body.files[0] === "a.txt") await firstHeld;
      return envelope({ undo: { id: `undo-${body.files[0]}`, paths: body.files, skipped: [] } });
    });

    host.send({ command: "discardFiles", paths: ["a.txt"], reqId: 7 });
    host.send({ command: "discardFiles", paths: ["b.txt"], reqId: 8 });
    await host.until(() => host.sent("actionResult").length === 1);
    releaseFirst();
    await host.until(() => host.sent("actionResult").length === 2);

    expect(host.sent("actionResult").map((m) => [m.reqId, m.result.data.undo.id])).toEqual([[8, "undo-b.txt"], [7, "undo-a.txt"]]);
  });

  it("echoes it on a git action's answer, and on the error of a request it could not start", async () => {
    host = await openPanelHost();
    host.send({ command: "gitAction", action: "createTag", args: { name: "v1" }, reqId: 3 });
    host.send({ command: "sync", action: "bogus", reqId: 4 });
    await host.until(() => host.sent("actionResult").length === 1 && host.sent("error").length === 1);

    expect(host.sent("actionResult")[0]).toMatchObject({ action: "createTag", reqId: 3, result: { ok: true } });
    expect(host.sent("error")[0]).toMatchObject({ failed: "bogus", reqId: 4 });
  });
});

describe("the panel", () => {
  let page: PanelPage;
  afterEach(() => page.close());

  const toasts = () => [...page.document.querySelectorAll("#toast-host .toast-text")].map((el) => el.textContent);

  it("hands each answer to the request whose id it echoes, whichever comes back first", () => {
    page = openPanelPage();
    page.read("updateSubmodules")([{ path: "one" }, { path: "two" }]);
    const [one, two] = page.posted.filter((m) => m.command === "updateSubmodule");
    expect([one!.path, two!.path]).toEqual(["one", "two"]);
    expect(one!.reqId).not.toBe(two!.reqId);

    page.send({ command: "actionResult", action: "updateSubmodule", reqId: two!.reqId, result: { ok: false, error: "two is broken" } });
    page.send({ command: "actionResult", action: "updateSubmodule", reqId: one!.reqId, result: { ok: true } });

    expect(toasts()).toEqual(["Could not update twotwo is broken", "Updated one"]);
  });

  it("fails the request an error names by its id, and no other", () => {
    page = openPanelPage();
    page.read("updateSubmodules")([{ path: "one" }, { path: "two" }]);
    const [one, two] = page.posted.filter((m) => m.command === "updateSubmodule");

    page.send({ command: "error", message: "no such submodule", failed: "updateSubmodule", reqId: two!.reqId });
    page.send({ command: "actionResult", action: "updateSubmodule", reqId: one!.reqId, result: { ok: true } });

    expect(toasts()).toEqual(["Could not update twono such submodule", "Updated one"]);
  });
});
