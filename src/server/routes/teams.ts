import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import { listTeams, readTeamDetail } from "../ws/team-inbox-watcher.ts";
import { join } from "path";
import { homedir } from "os";
import { rm } from "fs/promises";

/** Allowlist: team names must be alphanumeric with hyphens/underscores only */
const VALID_TEAM_NAME = /^[a-zA-Z0-9_-]+$/;

export const teamRoutes = new Hono();

teamRoutes.get("/", async (c) => {
  const teams = await listTeams();
  return c.json(ok(teams));
});

teamRoutes.get("/:name", async (c) => {
  const name = c.req.param("name");
  if (!VALID_TEAM_NAME.test(name)) {
    return c.json(err("Invalid team name"), 400);
  }
  const detail = await readTeamDetail(name);
  if (!detail) return c.json(err("Team not found"), 404);
  return c.json(ok(detail));
});

/**
 * Live per-member activity. Separate from `/:name` because it is polled while the
 * panel is open, and because its source is the agent transcripts rather than the
 * team inboxes — the inboxes cannot say who is working right now.
 */
teamRoutes.get("/:name/activity", async (c) => {
  const name = c.req.param("name");
  if (!VALID_TEAM_NAME.test(name)) return c.json(err("Invalid team name"), 400);
  const { readTeamMemberActivity, readTeamOutboundMessages } = await import(
    "../../services/team-member-activity/member-activity.service.ts"
  );
  const projectPath = c.req.query("projectPath") ?? null;
  const [members, outbound] = await Promise.all([
    readTeamMemberActivity(name, projectPath),
    readTeamOutboundMessages(name, projectPath),
  ]);
  return c.json(ok({ members, outbound }));
});

/** Full transcript of one teammate's work session, for the member window. */
teamRoutes.get("/:name/members/:member/transcript", async (c) => {
  const name = c.req.param("name");
  const member = c.req.param("member");
  if (!VALID_TEAM_NAME.test(name)) return c.json(err("Invalid team name"), 400);
  if (!VALID_TEAM_NAME.test(member)) return c.json(err("Invalid member name"), 400);
  const { resolveMemberTranscript } = await import(
    "../../services/team-member-activity/member-activity.service.ts"
  );
  const path = resolveMemberTranscript(name, member, c.req.query("projectPath") ?? null);
  if (!path) return c.json(err("Member transcript not found"), 404);
  const { parseAgentTranscript } = await import("../../services/subagent-transcript-merger.ts");
  return c.json(ok({ member, events: parseAgentTranscript(path) }));
});

teamRoutes.delete("/:name", async (c) => {
  const name = c.req.param("name");
  if (!VALID_TEAM_NAME.test(name)) {
    return c.json(err("Invalid team name"), 400);
  }
  const teamDir = join(homedir(), ".claude", "teams", name);
  try {
    await rm(teamDir, { recursive: true, force: true });
    return c.json(ok({ deleted: name }));
  } catch (e) {
    return c.json(err(`Failed to delete: ${(e as Error).message}`), 500);
  }
});
