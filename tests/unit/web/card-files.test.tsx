/**
 * The files on a report card and the full-screen viewer a Telegram link opens (`/card-file/<id>`):
 * each row shows name, size, Open (Play for a video) and Download; a small picture shows a
 * thumbnail; Open shows the original, a video in the browser's own player streaming the bytes
 * route with Range (`controls`, `playsinline`, `preload="metadata"`); Download is a link answered
 * as an attachment; a pruned file says so. Buttons take the standard sizes with no invisible press
 * area.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement, Fragment } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { CardFiles } = await import("../../../src/web/components/assistant/cards/card-files");
const { CardFileViewer } = await import("../../../src/web/components/assistant/cards/card-file-viewer");
const { useCardFileViewer } = await import("../../../src/web/stores/card-file-viewer-store");
const { parseUrlState } = await import("../../../src/web/hooks/use-url-sync");
const { act } = await import("react");
type CardFile = import("../../../src/shared/card-files").CardFile;

const ID = "a".repeat(32);
const file = (over: Partial<CardFile>): CardFile => ({
  id: ID, name: "clip.mp4", size: 79 * 1024 * 1024, kind: "video", mime: "video/mp4", sha256: "0".repeat(64), ...over,
});

let infoStatus = 200;
let infoFile: CardFile = file({});
let view: Mounted | null = null;
const realFetch = globalThis.fetch;

beforeEach(() => {
  infoStatus = 200;
  infoFile = file({});
  localStorage.setItem("ppm-auth-token", "tok");
  useCardFileViewer.setState({ id: null });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/info")) {
      return infoStatus === 200
        ? Response.json({ ok: true, data: { file: infoFile } })
        : Response.json({ ok: false, error: "This file is no longer kept (files stay 30 days)" }, { status: infoStatus });
    }
    return new Response("bytes");
  }) as typeof fetch;
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
});

const flush = () => act(async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); });
const q = <T extends Element>(sel: string) => view!.container.querySelector<T>(sel);

describe("CardFiles on a card", () => {
  it("lists each file with its size and offers Play, View or only Download", async () => {
    view = await mount(createElement(CardFiles, { files: [
      file({}),
      file({ id: "b".repeat(32), name: "spec.pdf", kind: "pdf", mime: "application/pdf", size: 2048 }),
      file({ id: "c".repeat(32), name: "build.zip", kind: "other", mime: "application/octet-stream", size: 90 }),
    ] }));
    const rows = [...view.container.querySelectorAll("[data-card-file]")];
    expect(rows.map((r) => r.getAttribute("data-card-file"))).toEqual(["video", "pdf", "other"]);
    expect(rows.map((r) => r.querySelector("[data-card-file-open]")?.textContent ?? null)).toEqual(["Play", "View", null]);
    expect(view.container.textContent).toContain("79.0 MB");
    const dl = q<HTMLAnchorElement>("[data-card-file-download]")!;
    expect(dl.getAttribute("href")).toBe(`/api/card-files/${ID}?download=1&token=tok`);
    expect(dl.getAttribute("download")).toBe("clip.mp4");
  });

  it("shows a small picture's thumbnail straight from the bytes route", async () => {
    view = await mount(createElement(CardFiles, { files: [file({ name: "shot.png", kind: "image", mime: "image/png", size: 5000 })] }));
    expect(q("img")?.getAttribute("src")).toBe(`/api/card-files/${ID}?token=tok`);
  });

  it("opens the viewer on Play", async () => {
    view = await mount(createElement(CardFiles, { files: [file({})] }));
    await click(q("[data-card-file-open]"));
    expect(useCardFileViewer.getState().id).toBe(ID);
  });

  it("uses the standard text-button size and adds no invisible press area", async () => {
    view = await mount(createElement(CardFiles, { files: [file({})] }));
    for (const b of view.container.querySelectorAll("[data-card-file-open], [data-card-file-download]")) {
      expect(b.className).toContain("h-7");
      expect(b.className).toContain("max-md:h-[26px]");
      expect(b.className).not.toMatch(/(?:^|\s)after:/);
    }
  });
});

describe("the viewer (/card-file/<id>)", () => {
  it("is what a /card-file/<id> address asks for", () => {
    const at = (path: string) => { window.history.replaceState(null, "", path); return parseUrlState(); };
    expect(at(`/card-file/${ID}`).cardFileId).toBe(ID);
    expect(at("/card-file/not-an-id").cardFileId ?? null).toBeNull();
    window.history.replaceState(null, "", "/");
  });

  it("plays a video in the browser's own player, streaming with the token, and closes", async () => {
    view = await mount(createElement(Fragment, null, createElement(CardFileViewer)));
    await act(async () => { useCardFileViewer.getState().open(ID); });
    await flush();
    const video = q<HTMLVideoElement>("[data-testid=native-video] video")!;
    expect(video.getAttribute("src")).toBe(`/api/card-files/${ID}?token=tok`);
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.hasAttribute("playsinline")).toBe(true);
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(view.container.textContent).toContain("79.0 MB · original");
    const close = q<HTMLButtonElement>("[data-card-file-close]")!;
    expect(close.className).toContain("size-6");
    expect(close.className).toContain("max-md:size-[22px]");
    await click(close);
    expect(useCardFileViewer.getState().id).toBeNull();
  });

  it("shows a picture that a tap enlarges to its own pixels", async () => {
    infoFile = file({ name: "shot.png", kind: "image", mime: "image/png", size: 5000 });
    view = await mount(createElement(CardFileViewer));
    await act(async () => { useCardFileViewer.getState().open(ID); });
    await flush();
    const zoom = q("[data-testid=zoomable-image]")!;
    expect(zoom.getAttribute("data-zoom")).toBe("fit");
    await click(zoom.querySelector("img"));
    expect(zoom.getAttribute("data-zoom")).toBe("actual");
  });

  it("says a pruned file is no longer kept", async () => {
    infoStatus = 404;
    view = await mount(createElement(CardFileViewer));
    await act(async () => { useCardFileViewer.getState().open(ID); });
    await flush();
    expect(q("[role=alert]")?.textContent).toContain("no longer kept");
  });
});
