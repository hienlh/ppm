import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { _resetPpmDir } from "../../../../src/services/ppm-dir.ts";
import { IMPEXP_FILE_TTL_MS, folderPid, makeDir, wipeImpExpFiles, writeChunks } from "../../../../src/services/database/impexp/impexp-files.ts";
import {
  MAX_JOB_MESSAGES, MAX_RUNNING_JOBS, TooManyJobsError, addMessage, createJob, finishJob, getJob, jobFile, jobStatus,
  resetJobs, stopJob, sweepJobs,
} from "../../../../src/services/database/impexp/impexp-job-store.ts";

const originalPpmHome = process.env.PPM_HOME;
const homes: string[] = [];
let home: string;

const items = (...names: string[]) => names.map((n) => ({ source: n, target: `${n}.csv` }));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ppm-impexp-store-"));
  homes.push(home);
  process.env.PPM_HOME = home;
  _resetPpmDir();
});

afterEach(() => {
  resetJobs();
});

afterAll(() => {
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
});

describe("jobs", () => {
  it("starts with every row Queued, and an export with a folder of its own in the PPM directory", async () => {
    const job = await createJob("export", items("a", "b"));
    expect(job.state).toBe("running");
    expect(job.items).toEqual([
      { source: "a", target: "a.csv", state: "queued", rowsRead: 0, rowsWritten: 0 },
      { source: "b", target: "b.csv", state: "queued", rowsRead: 0, rowsWritten: 0 },
    ]);
    expect(job.dir!.startsWith(join(home, "db-impexp"))).toBe(true);
    expect(existsSync(job.dir!)).toBe(true);
    expect(getJob(job.id)).toBe(job);
    expect(job.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("gives an import no folder: its files are the uploads", async () => {
    expect((await createJob("import", items("a"))).dir).toBeNull();
  });

  it("runs at most MAX_RUNNING_JOBS at once, and a finished one makes room", async () => {
    const running = [];
    for (let i = 0; i < MAX_RUNNING_JOBS; i++) running.push(await createJob("export", items("a")));
    await expect(createJob("export", items("a"))).rejects.toBeInstanceOf(TooManyJobsError);
    finishJob(running[0]!, "done");
    await expect(createJob("export", items("a"))).resolves.toBeDefined();
  });

  it("takes the last slot once when two requests ask for it together", async () => {
    for (let i = 0; i < MAX_RUNNING_JOBS - 1; i++) await createJob("export", items("a"));
    const results = await Promise.allSettled([createJob("export", items("a")), createJob("export", items("a"))]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("keeps MAX_JOB_MESSAGES messages and counts the rest, which its end then says", async () => {
    const job = await createJob("export", items("a"));
    for (let i = 0; i < MAX_JOB_MESSAGES + 5; i++) addMessage(job, "info", `m${i}`);
    expect(job.messages).toHaveLength(MAX_JOB_MESSAGES);
    expect(job.dropped).toBe(5);
    finishJob(job, "done");
    expect(job.messages.at(-1)).toMatchObject({ level: "warning", text: "5 more messages were left out" });
  });

  it("ends once: a second end changes nothing", async () => {
    const job = await createJob("export", items("a"));
    finishJob(job, "error");
    const endedAt = job.endedAt;
    finishJob(job, "done");
    expect(job.state).toBe("error");
    expect(job.endedAt).toBe(endedAt);
  });

  it("lets go of a job whose folder cannot be made, so it holds no slot", async () => {
    const first = await createJob("export", items("a"));
    finishJob(first, "done");
    const exports = dirname(first.dir!);
    rmSync(exports, { recursive: true, force: true });
    writeFileSync(exports, "a file where the folder goes");
    for (let i = 0; i <= MAX_RUNNING_JOBS; i++) await expect(createJob("export", items("a"))).rejects.not.toBeInstanceOf(TooManyJobsError);
    rmSync(exports);
    expect((await createJob("export", items("a"))).state).toBe("running");
  });

  it("Stop aborts a running job only", async () => {
    const job = await createJob("export", items("a"));
    stopJob(job);
    expect(job.abort.signal.aborted).toBe(true);
    const ended = await createJob("export", items("a"));
    finishJob(ended, "done");
    stopJob(ended);
    expect(ended.abort.signal.aborted).toBe(false);
  });

  it("reports the messages from the since-th on, and its files without where the server keeps them", async () => {
    const job = await createJob("export", items("a"));
    addMessage(job, "info", "one");
    addMessage(job, "warning", "two");
    addMessage(job, "error", "three");
    job.files.push({ name: "a.csv", size: 3, path: join(job.dir!, "0"), format: "csv" });
    const status = jobStatus(job, 1);
    expect(status.messages.map((m) => m.text)).toEqual(["two", "three"]);
    expect(status.messageCount).toBe(3);
    expect(status.files).toEqual([{ name: "a.csv", size: 3 }]);
    expect(jobStatus(job, 99).messages).toEqual([]);
    expect(jobStatus(job, -4).messages).toHaveLength(3);
    expect(jobStatus(job, -1).messages).toHaveLength(3);
    expect(jobStatus(job, 1.9).messages.map((m) => m.text)).toEqual(["two", "three"]);
    expect(jobStatus(job, Number.NaN).messages).toHaveLength(3);
  });

  it("hands out copies: a status read is not changed by the job going on", async () => {
    const job = await createJob("export", items("a"));
    const status = jobStatus(job);
    job.items[0]!.rowsRead = 10;
    expect(status.items[0]!.rowsRead).toBe(0);
  });

  it("finds a file by the name it downloads as", async () => {
    const job = await createJob("export", items("a"));
    job.files.push({ name: "a.csv", size: 3, path: "/x/0", format: "csv" });
    expect(jobFile(job, "a.csv")?.path).toBe("/x/0");
    expect(jobFile(job, "A.csv")).toBeNull();
  });

  it("lets go of a job an hour after it ended, with its folder; a running one stays", async () => {
    const old = await createJob("export", items("a"));
    const recent = await createJob("export", items("a"));
    const running = await createJob("export", items("a"));
    finishJob(old, "done");
    finishJob(recent, "done");
    writeFileSync(join(old.dir!, "0"), "x");
    old.endedAt = Date.now() - IMPEXP_FILE_TTL_MS;
    recent.endedAt = Date.now() - IMPEXP_FILE_TTL_MS + 60_000;
    await sweepJobs();
    expect(getJob(old.id)).toBeNull();
    expect(existsSync(old.dir!)).toBe(false);
    expect(getJob(recent.id)).toBe(recent);
    expect(getJob(running.id)).toBe(running);
  });
});

describe("the files of servers no longer running", () => {
  it("tells a server's folder by its process id", () => {
    expect(folderPid("123-a1b2c3d4")).toBe(123);
    expect(folderPid("0-ab")).toBeNull();
    expect(folderPid("abc")).toBeNull();
    expect(folderPid("12-xyz")).toBeNull();
  });

  it("at startup removes the folders of servers that are gone, and keeps its own and a running server's", async () => {
    const job = await createJob("export", items("a"));
    const root = join(home, "db-impexp");
    const [own] = readdirSync(root);
    const alive = `${process.ppid}-00aa11bb`;
    const gone = "2147483646-00aa11bb";
    for (const name of [alive, gone, "stray"]) mkdirSync(join(root, name, "exports"), { recursive: true });
    await wipeImpExpFiles();
    expect(readdirSync(root).sort()).toEqual([own!, alive].sort());
    expect(existsSync(job.dir!)).toBe(true);
  });

  it("removes a folder of this process left by an earlier server that had its id", async () => {
    await createJob("export", items("a"));
    const root = join(home, "db-impexp");
    const [own] = readdirSync(root);
    const earlier = `${process.pid}-ffffffff`;
    mkdirSync(join(root, earlier));
    await wipeImpExpFiles();
    expect(readdirSync(root)).toEqual([own!]);
  });

  it.skipIf(process.platform === "win32" || process.pid === 1)("keeps the folder of a running server it may not signal", async () => {
    await createJob("export", items("a"));
    const root = join(home, "db-impexp");
    // Process 1 always runs, and belongs to root: signalling it is refused (EPERM), not answered ESRCH.
    mkdirSync(join(root, "1-00aa11bb"));
    await wipeImpExpFiles();
    expect(readdirSync(root)).toContain("1-00aa11bb");
  });

  it("does nothing when there is no folder yet", async () => {
    await expect(wipeImpExpFiles()).resolves.toBeUndefined();
  });
});

describe("a job's files on disk", () => {
  async function* pieces(...texts: string[]): AsyncGenerator<Uint8Array> {
    for (const t of texts) yield new TextEncoder().encode(t);
  }

  it("writes a new file only its owner may read, in a folder only its owner may open, answering its size", async () => {
    const dir = await makeDir(join(home, "w"));
    const path = join(dir, "0");
    expect(await writeChunks(path, pieces("ab", "cde"), new AbortController().signal)).toBe(5);
    expect(readFileSync(path, "utf8")).toBe("abcde");
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it.skipIf(process.platform !== "linux")("closes the file it wrote", async () => {
    const path = join(await makeDir(join(home, "w")), "0");
    await writeChunks(path, pieces("x"), new AbortController().signal);
    const held = readdirSync("/proc/self/fd").filter((fd) => {
      try {
        return readlinkSync(`/proc/self/fd/${fd}`) === path;
      } catch {
        return false;
      }
    });
    expect(held).toEqual([]);
  });

  it("never writes over a file that is there", async () => {
    const path = join(await makeDir(join(home, "w")), "0");
    writeFileSync(path, "keep");
    await expect(writeChunks(path, pieces("x"), new AbortController().signal)).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe("keep");
  });
});
