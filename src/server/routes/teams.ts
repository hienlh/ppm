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
