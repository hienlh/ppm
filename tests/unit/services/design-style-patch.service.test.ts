import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesign } from "../../../src/services/design/design-store.service.ts";
import { commitStylePatch } from "../../../src/services/design/design-style-patch.service.ts";
import { undoEdit, resetDesignUndoJournals } from "../../../src/services/design/design-edit-undo-journal.ts";
import { designWriteClock, resetDesignWriteLimits } from "../../../src/services/design/design-write-rate-limit.ts";
import { listSnapshots } from "../../../src/services/design/design-snapshots.service.ts";
import { computeGen } from "../../../src/services/design/source/design-source-file.ts";

const PAGE = '<!doctype html>\r\n<html><head><title>T</title></head><body>\r\n<div class="hero" style="color: red">Hi</div>\r\n<p>Body text long enough to keep later edits well clear of the hero.</p>\r\n<footer>Foot</footer>\r\n</body></html>';
const BOM = "\uFEFF";

describe("commitStylePatch", () => {
  let project: string;
  let dir: string;
  let now = 0;
  const realNow = designWriteClock.now;
  const read = () => readFileSync(join(dir, "index.html"), "utf8");
  const text = () => read().replace(/^\uFEFF/, "");
  const divId = () => text().indexOf("<div");
  const commit = (over: Record<string, unknown> = {}) => commitStylePatch(project, "home", {
    file: "index.html", gen: computeGen(text()), ppmId: divId(), tag: "div", props: { translate: "12px -3px" }, ...over,
  });

  beforeEach(async () => {
    resetDesignWriteLimits();
    resetDesignUndoJournals();
    now = 1_000_000;
    // Each write a second after the last, so only the rate-limit test ever meets the limit.
    designWriteClock.now = () => (now += 1000);
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-style-")));
    await createDesign(project, { title: "Home", kind: "page" });
    dir = join(project, "designs", "home");
    writeFileSync(join(dir, "index.html"), BOM + PAGE);
  });
  afterEach(() => {
    designWriteClock.now = realNow;
    rmSync(project, { recursive: true, force: true });
  });

  it("changes only the element's style attribute, keeps the BOM and CRLF, snapshots and returns gen + undoId", async () => {
    const out = await commit({ props: { translate: "12px -3px", width: "240.5px" } });
    expect(read()).toBe(BOM + PAGE.replace('style="color: red"', 'style="color: red; translate: 12px -3px; width: 240.5px"'));
    expect(out.gen).toBe(computeGen(text()));
    expect(out.undoId).toMatch(/^[0-9a-f]{16}$/);
    expect((await listSnapshots(project, "home")).map((s) => s.reason)).toEqual(["before-edit"]);
  });

  it("refuses a stale gen with 409 stale and the current gen, writing nothing", async () => {
    const error = await commit({ gen: "0123456789abcdef" }).catch((e) => e);
    expect(error).toMatchObject({ status: 409, code: "stale", currentGen: computeGen(PAGE) });
    expect(read()).toBe(BOM + PAGE);
    expect(await listSnapshots(project, "home")).toEqual([]);
  });

  it("refuses an offset that is no longer that tag with 409 element-moved", async () => {
    await expect(commit({ tag: "p" })).rejects.toMatchObject({ status: 409, code: "element-moved" });
    await expect(commit({ ppmId: divId() + 1 })).rejects.toMatchObject({ status: 409, code: "element-moved" });
    expect(read()).toBe(BOM + PAGE);
  });

  it("answers 400 for props outside the allowlist and paths outside the design", async () => {
    for (const props of [{ color: "red" }, { width: "10%" }, { width: "1px;x" }, {}, { translate: "1px" }]) {
      await expect(commit({ props })).rejects.toMatchObject({ status: 400 });
    }
    for (const file of ["../other/index.html", ".design/x.html", "/abs.html", "styles.css"]) {
      await expect(commit({ file })).rejects.toMatchObject({ status: 400 });
    }
    expect(read()).toBe(BOM + PAGE);
  });

  it("enforces the per-design write limit on the server", async () => {
    designWriteClock.now = () => now;
    await commit();
    await expect(commit({ props: { translate: "1px 1px" } })).rejects.toMatchObject({ status: 429 });
  });

  it("undoes exactly its own patch, keeping an AI turn made since", async () => {
    const out = await commit();
    const aiTurn = text().replace("<footer>Foot</footer>", "<footer>Rewritten by the AI in a later turn</footer>");
    writeFileSync(join(dir, "index.html"), BOM + aiTurn);
    await undoEdit(project, "home", out.undoId);
    expect(read()).toBe(BOM + PAGE.replace("<footer>Foot</footer>", "<footer>Rewritten by the AI in a later turn</footer>"));
  });
});
