import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { openTestDb, setDb, setSessionMetadata } from "../../src/services/db.service.ts";
import { chatRoutes } from "../../src/server/routes/chat.ts";

// Project path -> SDK encodes by replacing "/" with "-" (mirrors resolveSessionJsonlPath).
const PROJECT_PATH = "/__ppm_tasks_test__";
const encoded = PROJECT_PATH.replace(/\//g, "-");
const jsonlDir = resolve(homedir(), ".claude", "projects", encoded);

function writeSession(sid: string, lines: object[]) {
  mkdirSync(jsonlDir, { recursive: true });
  writeFileSync(resolve(jsonlDir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
}

const get = (path: string) => chatRoutes.request(path);

describe("GET /chat/sessions/:id/tasks", () => {
  beforeEach(() => {
    setDb(openTestDb());
    // Keep resolver's homedir (process.env.HOME) aligned with validateJsonlPath's os.homedir().
    process.env.HOME = homedir();
  });
  afterAll(() => rmSync(jsonlDir, { recursive: true, force: true }));

  it("rebuilds task state from the full JSONL (create + update far apart)", async () => {
    const sid = "sess-tasks-1";
    setSessionMetadata(sid, "p", PROJECT_PATH);
    writeSession(sid, [
      { type: "assistant", uuid: "a1", message: { role: "assistant", content: [
        { type: "tool_use", id: "tu1", name: "TaskCreate", input: { subject: "Build X", description: "d", activeForm: "a" } },
      ] } },
      { type: "user", uuid: "u1", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu1", content: "Task #1 created successfully: Build X" },
      ] } },
      // filler turn simulating long history between create and update (FE would paginate this out)
      { type: "assistant", uuid: "a2", message: { role: "assistant", content: [{ type: "text", text: "working..." }] } },
      { type: "assistant", uuid: "a3", message: { role: "assistant", content: [
        { type: "tool_use", id: "tu2", name: "TaskUpdate", input: { taskId: "1", status: "completed" } },
      ] } },
    ]);

    const res = await get(`/sessions/${sid}/tasks`);
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: Array<{ id: string; subject: string; status: string }> };
    expect(data).toEqual([{ id: "1", subject: "Build X", status: "completed" }]);
  });

  it("returns [] for an unknown/fresh session", async () => {
    const res = await get(`/sessions/no-such-session/tasks`);
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: unknown[] };
    expect(data).toEqual([]);
  });
});
