/**
 * `ppm schedule add --session`: the body sent to the running PPM, and the direct write used when
 * none holds the database, which applies the route's rules for a schedule delivered into a chat.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { directPatch, editBody, sessionAddBody, sessionEditBody } from "../../../../src/cli/commands/schedule-cmd-write.ts";
import { configService } from "../../../../src/services/config.service.ts";
import { openTestDb, setDb, setSessionMetadata, setSessionProvider } from "../../../../src/services/db.service.ts";
import * as db from "../../../../src/services/scheduler-db.service.ts";
import { createSessionSchedule } from "../../../../src/services/session-schedules/session-schedule-save.ts";
import { ScheduleEditError } from "../../../../src/services/scheduler-edit.ts";
import type { ProjectConfig } from "../../../../src/types/config.ts";

const project = { name: "sched-cli", path: join(process.env.PPM_HOME!, "sched-cli") };
const CHAT = "chat-cli-session";
let savedProjects: ProjectConfig[];

beforeEach(() => {
  setDb(openTestDb());
  savedProjects = configService.get("projects");
  configService.set("projects", [...savedProjects, project]);
  setSessionMetadata(CHAT, project.name, project.path);
  setSessionProvider(CHAT, "claude");
});
afterEach(() => configService.set("projects", savedProjects));

describe("ppm schedule add --session", () => {
  it("sends a session body with the zone and one-shot flag, and no project of its own", () => {
    expect(sessionAddBody({ session: CHAT, cron: "0 9 * * *", prompt: "Stand-up notes", tz: "Europe/London", once: true }))
      .toEqual({ kind: "session", target_session_id: CHAT, cron_expr: "0 9 * * *", prompt: "Stand-up notes", recurring: false, enabled: true, timezone: "Europe/London" });
    expect(sessionAddBody({ session: CHAT, cron: "0 9 * * *", prompt: "p", name: "Daily", disabled: true }))
      .toMatchObject({ name: "Daily", recurring: true, enabled: false });
  });

  it("writes directly by the route's rules when no PPM holds the database", () => {
    const body = sessionAddBody({ session: CHAT, cron: "0 9 * * *", prompt: "p", tz: "Asia/Saigon" });
    expect(createSessionSchedule(body)).toMatchObject({ kind: "session", target_session_id: CHAT, project_path: project.path, timezone: "Asia/Saigon" });
    expect(() => createSessionSchedule({ ...body, timezone: "Not/AZone" })).toThrow(ScheduleEditError);
  });

  it("enables a paused one directly by clearing its pause", async () => {
    const created = createSessionSchedule(sessionAddBody({ session: CHAT, cron: "0 9 * * *", prompt: "p" }));
    db.setSessionSchedulePaused(created.id, "paused for the test");
    await directPatch(db, db.getSchedule(created.id)!, { enabled: true });
    expect(db.getSchedule(created.id)!.paused_reason).toBeNull();
  });
});

describe("ppm schedule edit on a schedule delivered into a chat", () => {
  it("names the flags it did not use and sends only the rest", () => {
    const opts = { name: "Renamed", project: "elsewhere", maxTurns: "3", timeout: "1000", permissionMode: "plan" };
    const { body, ignored } = sessionEditBody(opts, editBody(opts, "/somewhere/else"));
    expect(ignored).toEqual(["--project", "--permission-mode", "--max-turns", "--timeout"]);
    expect(body).toEqual({ name: "Renamed" });
  });

  it("ignores nothing when only flags that apply are given", () => {
    const opts = { cron: "0 8 * * *", prompt: "New prompt" };
    expect(sessionEditBody(opts, editBody(opts))).toEqual({ body: { cron_expr: "0 8 * * *", prompt: "New prompt" }, ignored: [] });
  });
});
