/**
 * `/api/schedules` for schedules that deliver into an existing chat: the chat decides the
 * project and provider, the shared rules refuse a bad zone, cron or a chat already at its cap, a
 * chat's own schedules can be listed by its id, and turning a paused one on clears the pause.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { configService } from "../../../src/services/config.service.ts";
import { openTestDb, setDb, setSessionMetadata, setSessionProvider, setSessionTitle } from "../../../src/services/db.service.ts";
import { getSchedule, insertSchedule, setSessionSchedulePaused } from "../../../src/services/scheduler-db.service.ts";
import { schedulesRoutes } from "../../../src/server/routes/schedules.ts";
import { MAX_SCHEDULES_PER_SESSION } from "../../../src/shared/session-schedule-input.ts";
import type { ProjectConfig } from "../../../src/types/config.ts";

const project = { name: "sched-routes", path: join(process.env.PPM_HOME!, "sched-routes") };
const CHAT = "chat-routes-a";
const OTHER = "chat-routes-b";
let savedProjects: ProjectConfig[];

const send = (method: string, path: string, body?: unknown) => schedulesRoutes.request(path, {
  method, headers: { "Content-Type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }),
});
const json = async (res: Response) => (await res.json()) as { data?: any; error?: string; problems?: string[]; code?: string };

function chat(id: string, title?: string): void {
  setSessionMetadata(id, project.name, project.path);
  setSessionProvider(id, "claude");
  if (title) setSessionTitle(id, title);
}

beforeEach(() => {
  setDb(openTestDb());
  savedProjects = configService.get("projects");
  configService.set("projects", [...savedProjects, project]);
  chat(CHAT, "Release chat");
  chat(OTHER);
});
afterEach(() => configService.set("projects", savedProjects));

describe("POST a session schedule", () => {
  it("takes the project and provider from the chat and reads only what a session schedule has", async () => {
    const res = await send("POST", "/", {
      kind: "session", target_session_id: CHAT, cron_expr: "30 8 * * 1-5", prompt: "Morning check", timezone: "asia/saigon",
      recurring: false, project_path: "/somewhere/else", permission_mode: "plan", max_turns: 3,
    });
    expect(res.status).toBe(201);
    const { data } = await json(res);
    expect(data).toMatchObject({
      kind: "session", target_session_id: CHAT, target_title: "Release chat", project_path: project.path, provider_id: "claude",
      timezone: "Asia/Saigon", recurring: 0, name: "Morning check", enabled: 1, paused_reason: null, pending_since: null,
    });
    expect(data.next_fire_at).not.toBeNull();
    expect(getSchedule(data.id)!.max_turns).toBeNull();
  });

  it("refuses a bad zone and a chat that does not exist, with what is wrong", async () => {
    const zone = await send("POST", "/", { kind: "session", target_session_id: CHAT, cron_expr: "0 9 * * *", prompt: "x", timezone: "Nowhere/Land" });
    expect(zone.status).toBe(400);
    expect((await json(zone)).problems!.join(" ")).toContain("IANA");
    const gone = await send("POST", "/", { kind: "session", target_session_id: "chat-never-was", cron_expr: "0 9 * * *", prompt: "x" });
    expect(gone.status).toBe(400);
    expect((await json(gone)).error).toContain("no longer exists");
  });

  it(`answers 409 for the schedule after ${MAX_SCHEDULES_PER_SESSION} in one chat`, async () => {
    for (let i = 0; i < MAX_SCHEDULES_PER_SESSION; i++) {
      expect((await send("POST", "/", { kind: "session", target_session_id: CHAT, cron_expr: "0 9 * * *", prompt: `p${i}` })).status).toBe(201);
    }
    const over = await send("POST", "/", { kind: "session", target_session_id: CHAT, cron_expr: "0 9 * * *", prompt: "more" });
    expect(over.status).toBe(409);
    expect((await json(over)).code).toBe("limit");
  });
});

describe("listing and changing session schedules", () => {
  const seed = (target: string) => insertSchedule({
    name: "s", cron_expr: "0 9 * * *", provider_id: "claude", project_path: project.path, prompt: "p", kind: "session", target_session_id: target,
  });

  it("lists one chat's schedules by its id, and refuses something that is not a chat id", async () => {
    const mine = seed(CHAT);
    seed(OTHER);
    insertSchedule({ name: "prompt", cron_expr: "0 9 * * *", provider_id: "claude", project_path: project.path, prompt: "p" });
    const { data } = await json(await send("GET", `/?session=${CHAT}`));
    expect(data.map((s: { id: number }) => s.id)).toEqual([mine]);
    expect(data[0].target_title).toBe("Release chat");
    expect((await json(await send("GET", "/"))).data).toHaveLength(3);
    expect((await send("GET", "/?session=..%2Fetc")).status).toBe(400);
  });

  it("retimes in the new zone, and refuses moving the schedule to another chat", async () => {
    const id = seed(CHAT);
    const res = await send("PATCH", `/${id}`, { cron_expr: "0 7 * * *", timezone: "Europe/London" });
    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data).toMatchObject({ cron_expr: "0 7 * * *", timezone: "Europe/London" });
    expect(new Date(data.next_fire_at).getUTCHours()).toBe(7);
    const moved = await send("PATCH", `/${id}`, { target_session_id: OTHER });
    expect(moved.status).toBe(400);
    expect(getSchedule(id)!.target_session_id).toBe(CHAT);
  });

  it("clears a pause when turned on, and keeps it while the chat still cannot take the schedule", async () => {
    const id = seed(CHAT);
    setSessionSchedulePaused(id, "The chat this schedule runs in no longer exists.");
    expect((await json(await send("PATCH", `/${id}`, { enabled: true }))).data.paused_reason).toBeNull();

    const orphan = seed("chat-routes-gone");
    setSessionSchedulePaused(orphan, "gone");
    const refused = await send("PATCH", `/${orphan}`, { enabled: true, name: "renamed" });
    expect(refused.status).toBe(400);
    expect(getSchedule(orphan)).toMatchObject({ paused_reason: "gone", name: "s" });
  });
});
