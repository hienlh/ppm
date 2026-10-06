/**
 * The Git Graph's discard offers an Undo only for what PPM kept a copy of.
 *
 * A file over 20 MB is discarded without a copy, and the answer says so: the
 * record keeps no path and names the file under `skipped`. The panel offered an
 * Undo anyway, and clicking it "Restored" a file that was gone for good.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { openPanelPage, type PanelPage } from "./panel-test-harness.ts";

let page: PanelPage;
afterEach(() => page.close());

const toasts = () => [...page.document.querySelectorAll("#toast-host .toast")].map((el) => ({
  text: el.querySelector(".toast-text span")!.textContent,
  undo: !!el.querySelector('[data-toast="undo"]'),
}));

function discard(paths: string[], undo: { paths: string[]; skipped?: string[] }) {
  page.read("discardFiles")(paths.map((path) => ({ path })));
  const asked = page.posted.findLast((m) => m.command === "discardFiles")!;
  page.send({ command: "actionResult", action: "discardFiles", reqId: asked.reqId, result: { ok: true, data: { undo: { id: "rec-1", ...undo } } } });
}

describe("a discard in the Git Graph", () => {
  it("offers no Undo when nothing could be kept", () => {
    page = openPanelPage();
    discard(["big.bin"], { paths: [], skipped: ["big.bin"] });
    expect(toasts()).toEqual([{ text: "big.bin could not be kept, so it cannot be restored", undo: false }]);
  });

  it("offers Undo for what was kept, and restores only that by name", () => {
    page = openPanelPage();
    discard(["a.txt", "big.bin"], { paths: ["a.txt"], skipped: ["big.bin"] });
    expect(toasts()).toEqual([
      { text: "Discarded changes to 2 files", undo: true },
      { text: "big.bin could not be kept, so it cannot be restored", undo: false },
    ]);

    (page.document.querySelector('[data-toast="undo"]') as HTMLElement).click();
    const undo = page.posted.findLast((m) => m.command === "undoDiscard")!;
    expect(undo.id).toBe("rec-1");
    page.send({ command: "actionResult", action: "undoDiscard", reqId: undo.reqId, result: { ok: true } });
    expect(toasts().at(-1)).toEqual({ text: "Restored a.txt", undo: false });
  });
});
