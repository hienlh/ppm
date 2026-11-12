import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchBackgroundTasks } from "../../../src/providers/antigravity/background-task-watch.ts";

const CONV = "ec27ac8e-baef-4c02-90d1-78b449909261";

describe("watchBackgroundTasks", () => {
  let dir: string;
  let since: number;
  const task = (n: number, mtimeMs = Date.now()) => {
    const file = join(dir, "tasks", `task-${n}.log`);
    writeFileSync(file, "running\n");
    utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  };
  const message = (name: string, sender: string) =>
    writeFileSync(join(dir, "messages", `${name}.json`), JSON.stringify({ id: name, recipient: CONV, sender, content: `Task id "${sender}" finished with result: ok` }));
  const watch = (onReport: () => void) => watchBackgroundTasks({ systemDir: dir, conversationId: CONV, since, onReport, pollMs: 10 });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ppm-agy-tasks-"));
    mkdirSync(join(dir, "tasks"));
    mkdirSync(join(dir, "messages", "undelivered"), { recursive: true });
    writeFileSync(join(dir, "messages", "read.json"), "{}");
    since = Date.now() - 1000;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reports once, when a task still running reports back", async () => {
    task(7);
    let reports = 0;
    const w = watch(() => reports++);
    expect(w).not.toBeNull();
    await Bun.sleep(50);
    expect(reports).toBe(0);
    message("m1", `${CONV}/task-7`);
    await Bun.sleep(60);
    message("m2", `${CONV}/task-7`);
    await Bun.sleep(60);
    expect(reports).toBe(1);
  });

  it("does not watch when every task has already reported back, or none was started", () => {
    expect(watch(() => {})).toBeNull();
    task(3);
    message("m1", `${CONV}/task-3`);
    expect(watch(() => {})).toBeNull();
  });

  it("ignores a task of an earlier process, which never reports back", () => {
    task(2, since - 60_000);
    expect(watch(() => {})).toBeNull();
  });

  it("ignores messages that are not this conversation's task reports", async () => {
    task(7);
    let reports = 0;
    const w = watch(() => reports++);
    message("other", `0e2b9b41-aaaa-4bbb-8ccc-000000000001/task-7`);
    message("system", "system");
    message("user", CONV);
    writeFileSync(join(dir, "messages", "broken.json"), "{");
    await Bun.sleep(60);
    expect(reports).toBe(0);
    w!.stop();
  });

  it("stops watching on stop()", async () => {
    task(7);
    let reports = 0;
    const w = watch(() => reports++);
    w!.stop();
    message("m1", `${CONV}/task-7`);
    await Bun.sleep(60);
    expect(reports).toBe(0);
  });
});
