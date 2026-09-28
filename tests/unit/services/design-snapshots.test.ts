import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesign } from "../../../src/services/design/design-store.service.ts";
import { listSnapshots, snapshotDesign, SNAPSHOT_MAX_BYTES } from "../../../src/services/design/design-snapshots.service.ts";
import { EDIT_SNAPSHOT_CAP, SNAPSHOT_CAP, snapshotFilesDir } from "../../../src/services/design/design-snapshot-history.ts";
import { onDesignEvent, type DesignEventPayload } from "../../../src/services/design/design-events.ts";

describe("design snapshots", () => {
  let project: string;
  let dir: string;
  let events: DesignEventPayload[];
  let off: () => void;

  beforeEach(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-snap-")));
    await createDesign(project, { title: "Home", kind: "page" });
    dir = join(project, "designs", "home");
    events = [];
    off = onDesignEvent((type, payload) => {
      if (type === "history_changed") events.push(payload);
    });
  });
  afterEach(() => {
    off();
    rmSync(project, { recursive: true, force: true });
  });

  const write = (rel: string, text: string) => {
    const path = join(dir, ...rel.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  };

  it("copies the design, minus .design, and records who took it", async () => {
    write("assets/a.css", "body{}");
    const result = await snapshotDesign(project, "home", "turn", { sessionId: "s1" });
    expect("id" in result).toBe(true);
    const id = (result as { id: string }).id;
    const files = snapshotFilesDir(dir, id);
    expect(readFileSync(join(files, "assets", "a.css"), "utf8")).toBe("body{}");
    expect(readFileSync(join(files, "index.html"), "utf8")).toBe(readFileSync(join(dir, "index.html"), "utf8"));
    expect(existsSync(join(files, ".design"))).toBe(false);
    const [info] = await listSnapshots(project, "home");
    expect(info).toMatchObject({ id, reason: "turn", sessionId: "s1", fileCount: 3 });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ projectPath: project, slug: "home" });
  });

  it("adds nothing when nothing changed", async () => {
    const first = await snapshotDesign(project, "home", "turn");
    const second = await snapshotDesign(project, "home", "turn");
    expect(second).toEqual({ skipped: "unchanged", sameAs: (first as { id: string }).id });
    expect(await listSnapshots(project, "home")).toHaveLength(1);
    expect(events).toHaveLength(1);
    write("index.html", "<p>changed</p>");
    expect("id" in (await snapshotDesign(project, "home", "turn"))).toBe(true);
    expect(await listSnapshots(project, "home")).toHaveLength(2);
  });

  it("detects a rename or a content change of the same size", async () => {
    write("a.txt", "aaaa");
    await snapshotDesign(project, "home", "turn");
    write("a.txt", "bbbb");
    expect("id" in (await snapshotDesign(project, "home", "turn"))).toBe(true);
    rmSync(join(dir, "a.txt"));
    write("b.txt", "bbbb");
    expect("id" in (await snapshotDesign(project, "home", "turn"))).toBe(true);
  });

  it("never lets before-edit snapshots evict turn snapshots", async () => {
    for (let i = 0; i < 3; i++) {
      write("index.html", `turn ${i}`);
      await snapshotDesign(project, "home", "turn");
    }
    for (let i = 0; i < EDIT_SNAPSHOT_CAP + 10; i++) {
      write("index.html", `edit ${i}`);
      await snapshotDesign(project, "home", "before-edit");
    }
    const history = await listSnapshots(project, "home");
    expect(history.filter((s) => s.reason === "turn")).toHaveLength(3);
    const edits = history.filter((s) => s.reason === "before-edit");
    expect(edits).toHaveLength(EDIT_SNAPSHOT_CAP);
    // The newest ones are the ones kept.
    expect(readFileSync(join(snapshotFilesDir(dir, edits[0]!.id), "index.html"), "utf8")).toBe(`edit ${EDIT_SNAPSHOT_CAP + 9}`);
  });

  it("keeps the newest protected snapshots up to the cap", async () => {
    for (let i = 0; i < SNAPSHOT_CAP + 3; i++) {
      write("index.html", `turn ${i}`);
      await snapshotDesign(project, "home", i % 2 ? "manual" : "turn");
    }
    const history = await listSnapshots(project, "home");
    expect(history).toHaveLength(SNAPSHOT_CAP);
    expect(readFileSync(join(snapshotFilesDir(dir, history.at(-1)!.id), "index.html"), "utf8")).toBe("turn 3");
    expect(readdirSync(join(dir, ".design", "history")).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
  });

  it("does not dedupe a protected snapshot against an evictable before-edit one", async () => {
    await snapshotDesign(project, "home", "before-edit");
    const turn = await snapshotDesign(project, "home", "turn");
    expect("id" in turn).toBe(true);
    expect(await snapshotDesign(project, "home", "before-edit")).toMatchObject({ skipped: "unchanged" });
  });

  it("skips a design over the size budget, with no event", async () => {
    writeFileSync(join(dir, "video.mp4"), "");
    truncateSync(join(dir, "video.mp4"), SNAPSHOT_MAX_BYTES + 1);
    expect(await snapshotDesign(project, "home", "turn")).toEqual({ skipped: "too-large" });
    expect(await listSnapshots(project, "home")).toEqual([]);
    expect(events).toHaveLength(0);
  });

  it("reports a missing design as skipped instead of failing the turn", async () => {
    expect(await snapshotDesign(project, "gone", "turn")).toEqual({ skipped: "missing" });
    await expect(snapshotDesign(project, "home", "bogus" as never)).rejects.toMatchObject({ status: 400 });
  });

  it("does not copy a symlink, and recreates a deleted .gitignore", async () => {
    if (process.platform === "win32") return;
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-snap-out-")));
    writeFileSync(join(outside, "secret"), "secret");
    symlinkSync(join(outside, "secret"), join(dir, "secret"));
    rmSync(join(dir, ".design", ".gitignore"));
    try {
      const result = await snapshotDesign(project, "home", "turn");
      const files = snapshotFilesDir(dir, (result as { id: string }).id);
      expect(existsSync(join(files, "secret"))).toBe(false);
      expect(readFileSync(join(dir, ".design", ".gitignore"), "utf8")).toBe("*\n");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("serializes concurrent snapshots of one design", async () => {
    write("index.html", "same");
    const results = await Promise.all([1, 2, 3, 4].map(() => snapshotDesign(project, "home", "turn")));
    expect(results.filter((r) => "id" in r)).toHaveLength(1);
    expect(await listSnapshots(project, "home")).toHaveLength(1);
  });
});
