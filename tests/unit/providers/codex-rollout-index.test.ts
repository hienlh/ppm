import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCodexRollouts } from "../../../src/providers/codex-app-server/codex-history.ts";
import { clearRolloutIndex, indexedRollouts } from "../../../src/providers/codex-app-server/codex-rollout-index.ts";

const CWD_A = join(tmpdir(), "project-a");
const CWD_B = join(tmpdir(), "project-b");

let dir: string;
const day = () => join(dir, "2026", "11", "04");
const line = (r: unknown) => JSON.stringify(r) + "\n";
const meta = (id: string, cwd: string) =>
  line({ type: "session_meta", payload: { id, cwd, timestamp: "2026-11-04T00:00:00Z" } });
const prompt = (text: string) => line({ type: "event_msg", payload: { type: "user_message", message: text } });

function write(id: string, body: string): string {
  mkdirSync(day(), { recursive: true });
  const file = join(day(), `rollout-${id}.jsonl`);
  writeFileSync(file, body);
  return file;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-index-"));
  clearRolloutIndex();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("codex rollout index", () => {
  it("does not read a file again while its size and modification time are unchanged", async () => {
    const id = "aaaaaaaa-1111-4111-8111-111111111111";
    const file = write(id, meta(id, CWD_A));
    const before = statSync(file);
    expect((await listCodexRollouts(dir, CWD_A, "codex")).map((s) => s.id)).toEqual([id]);

    // Same length, another project, and the old timestamps put back: only a cached header
    // can still place it in project A.
    writeFileSync(file, meta(id, CWD_B));
    expect(statSync(file).size).toBe(before.size);
    utimesSync(file, before.atime, before.mtime);
    expect((await listCodexRollouts(dir, CWD_A, "codex")).map((s) => s.id)).toEqual([id]);
  });

  it("reads a file again once it is rewritten", async () => {
    const id = "bbbbbbbb-1111-4111-8111-111111111111";
    const file = write(id, meta(id, CWD_A));
    expect(await listCodexRollouts(dir, CWD_A, "codex")).toHaveLength(1);

    writeFileSync(file, meta(id, CWD_B));
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    expect(await listCodexRollouts(dir, CWD_A, "codex")).toEqual([]);
    expect((await listCodexRollouts(dir, CWD_B, "codex")).map((s) => s.id)).toEqual([id]);
  });

  it("picks up the opening prompt once codex has written it", async () => {
    const id = "cccccccc-1111-4111-8111-111111111111";
    const file = write(id, meta(id, CWD_A));
    expect((await listCodexRollouts(dir, CWD_A, "codex"))[0]?.title).toBe("Codex session");

    appendFileSync(file, prompt("Fix the login page"));
    expect((await listCodexRollouts(dir, CWD_A, "codex"))[0]?.title).toBe("Fix the login page");
  });

  it("keeps a session's title as the transcript grows", async () => {
    const id = "dddddddd-1111-4111-8111-111111111111";
    const file = write(id, meta(id, CWD_A) + prompt("First question"));
    expect((await listCodexRollouts(dir, CWD_A, "codex"))[0]?.title).toBe("First question");

    appendFileSync(file, prompt("A later question"));
    const [session] = await listCodexRollouts(dir, CWD_A, "codex");
    expect(session?.title).toBe("First question");
    expect(session?.updatedAt).toBe(statSync(file).mtime.toISOString());
  });

  it("drops a file that was deleted", async () => {
    const id = "eeeeeeee-1111-4111-8111-111111111111";
    const file = write(id, meta(id, CWD_A));
    expect(await listCodexRollouts(dir, CWD_A, "codex")).toHaveLength(1);
    rmSync(file);
    expect(await listCodexRollouts(dir, CWD_A, "codex")).toEqual([]);
  });

  it("gives callers that arrive together one pass over the tree", async () => {
    const id = "ffffffff-1111-4111-8111-111111111111";
    write(id, meta(id, CWD_A));
    const first = indexedRollouts(dir);
    expect(indexedRollouts(dir)).toBe(first);
    await first;
    expect(indexedRollouts(dir)).not.toBe(first);
  });

  it("lists the newest session first and titles the page it returns", async () => {
    const ids = ["11111111-aaaa-4111-8111-111111111111", "22222222-aaaa-4111-8111-111111111111"];
    const files = ids.map((id, i) => write(id, meta(id, CWD_A) + prompt(`Question ${i}`)));
    utimesSync(files[0]!, new Date(), new Date(Date.now() - 60_000));
    const [newest] = await listCodexRollouts(dir, CWD_A, "codex", { limit: 1 });
    expect(newest?.id).toBe(ids[1]);
    expect(newest?.title).toBe("Question 1");
  });
});
