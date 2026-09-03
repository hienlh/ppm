import { describe, it, expect, afterEach } from "bun:test";
import { extractTeamName, readTeamConfig, listTeams, readTeamDetail, teamExists } from "../../../src/server/ws/team-inbox-watcher.ts";
import { join } from "path";
import { homedir } from "os";
import { mkdir, rm, writeFile } from "fs/promises";

describe("extractTeamName", () => {
  it("extracts team_name from direct JSON object", () => {
    const input = '{"team_name": "my-team"}';
    const result = extractTeamName(input);
    expect(result).toBe("my-team");
  });

  it("extracts name field from direct JSON object", () => {
    const input = '{"name": "fallback-team"}';
    const result = extractTeamName(input);
    expect(result).toBe("fallback-team");
  });

  it("prefers team_name over name field", () => {
    const input = '{"team_name": "primary", "name": "fallback"}';
    const result = extractTeamName(input);
    expect(result).toBe("primary");
  });

  it("extracts from content-block array with text field", () => {
    const input = '[{"type":"text","text":"{\\"team_name\\":\\"found-team\\"}"}]';
    const result = extractTeamName(input);
    expect(result).toBe("found-team");
  });

  it("extracts from content-block array with name field", () => {
    const input = '[{"type":"text","text":"{\\"name\\":\\"found-via-name\\"}"}]';
    const result = extractTeamName(input);
    expect(result).toBe("found-via-name");
  });

  it("uses regex fallback for non-JSON text", () => {
    const input = 'random text with "team_name": "found-it" somewhere';
    const result = extractTeamName(input);
    expect(result).toBe("found-it");
  });

  it("handles quoted JSON strings in content blocks", () => {
    const input = '[{"type":"text","text":"{\\"team_name\\":\\"quoted-team\\"}"},{"type":"other"}]';
    const result = extractTeamName(input);
    expect(result).toBe("quoted-team");
  });

  it("returns null for invalid JSON", () => {
    const input = "not valid json at all {][}";
    const result = extractTeamName(input);
    expect(result).toBeNull();
  });

  it("returns null for empty string", () => {
    const input = "";
    const result = extractTeamName(input);
    expect(result).toBeNull();
  });

  it("returns null when no team_name or name found", () => {
    const input = '{"other_field": "value"}';
    const result = extractTeamName(input);
    expect(result).toBeNull();
  });

  it("returns null for empty array", () => {
    const input = "[]";
    const result = extractTeamName(input);
    expect(result).toBeNull();
  });

  it("returns null for array with no text blocks", () => {
    const input = '[{"type":"image","src":"data.png"}]';
    const result = extractTeamName(input);
    expect(result).toBeNull();
  });

  it("returns null for text block with non-JSON text", () => {
    const input = '[{"type":"text","text":"just plain text"}]';
    const result = extractTeamName(input);
    expect(result).toBeNull();
  });

  it("extracts from multiple content blocks (uses first match)", () => {
    const input =
      '[{"type":"text","text":"no team here"},{"type":"text","text":"{\\"team_name\\":\\"second-block\\"}"}]';
    const result = extractTeamName(input);
    expect(result).toBe("second-block");
  });

  it("handles whitespace around team_name in regex fallback", () => {
    const input = 'output: "team_name" : "spaces-team"';
    const result = extractTeamName(input);
    expect(result).toBe("spaces-team");
  });

  it("extracts team name with special characters", () => {
    const input = '{"team_name": "team-with-dashes_and_underscores"}';
    const result = extractTeamName(input);
    expect(result).toBe("team-with-dashes_and_underscores");
  });

  it("handles nested JSON structures gracefully", () => {
    const input = '[{"type":"text","text":"{\\"team_name\\":\\"nested\\", \\"config\\":{\\"x\\":1}}"}]';
    const result = extractTeamName(input);
    expect(result).toBe("nested");
  });
});

describe("readTeamConfig", () => {
  it("returns null for nonexistent team", async () => {
    const result = await readTeamConfig("nonexistent-team-12345");
    expect(result).toBeNull();
  });

  it("returns null when config file does not exist", async () => {
    // Try to read a team that definitely won't exist
    const result = await readTeamConfig("_fake_team_xyz_" + Date.now());
    expect(result).toBeNull();
  });

  it("handles filesystem errors gracefully", async () => {
    // Attempt to read from an invalid path
    const result = await readTeamConfig("");
    expect(result).toBeNull();
  });
});

describe("listTeams", () => {
  it("returns array", async () => {
    const result = await listTeams();
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns array of team configs", async () => {
    const result = await listTeams();
    expect(Array.isArray(result)).toBe(true);
    // Each item should have expected team config properties
    if (result.length > 0) {
      expect(typeof result[0]).toBe("object");
    }
  });

  it("handles filesystem errors gracefully", async () => {
    const result = await listTeams();
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("readTeamDetail", () => {
  it("returns null for nonexistent team", async () => {
    const result = await readTeamDetail("nonexistent-team-99999");
    expect(result).toBeNull();
  });

  it("returns null when the team directory has neither config nor inboxes", async () => {
    const result = await readTeamDetail("_fake_detail_team_" + Date.now());
    expect(result).toBeNull();
  });

  it("handles filesystem errors gracefully", async () => {
    const result = await readTeamDetail("");
    expect(result).toBeNull();
  });
});

/** Claude Code creates the team implicitly, named after the session, and writes
 *  only inboxes/ — no config.json. Everything must still resolve from that. */
describe("implicit teams (inboxes only, no config.json)", () => {
  const TEAMS_DIR = join(homedir(), ".claude", "teams");
  const created: string[] = [];

  async function makeImplicitTeam(inboxes: Record<string, unknown[]>): Promise<string> {
    const name = `_ppm_test_implicit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const inboxDir = join(TEAMS_DIR, name, "inboxes");
    await mkdir(inboxDir, { recursive: true });
    created.push(name);
    for (const [agent, msgs] of Object.entries(inboxes)) {
      await writeFile(join(inboxDir, `${agent}.json`), JSON.stringify(msgs), "utf-8");
    }
    return name;
  }

  afterEach(async () => {
    for (const name of created.splice(0)) {
      await rm(join(TEAMS_DIR, name), { recursive: true, force: true });
    }
  });

  it("teamExists is true with inboxes and no config", async () => {
    const name = await makeImplicitTeam({ lead: [] });
    expect(await teamExists(name)).toBe(true);
  });

  it("teamExists is false for a directory with no inboxes and no config", async () => {
    const name = await makeImplicitTeam({});
    expect(await teamExists(name)).toBe(false);
  });

  it("teamExists is false for a nonexistent team", async () => {
    expect(await teamExists("_ppm_missing_team_" + Date.now())).toBe(false);
  });

  it("listTeams includes the team and derives members from inbox filenames", async () => {
    const name = await makeImplicitTeam({ lead: [], "dev-p1": [], "dev-p2": [] });
    const teams = await listTeams() as any[];
    const found = teams.find((t) => t.name === name);
    expect(found).toBeDefined();
    expect(found.implicit).toBe(true);
    expect(found.members.map((m: any) => m.name).sort()).toEqual(["dev-p1", "dev-p2", "lead"]);
  });

  it("readTeamDetail returns members and merged messages without a config", async () => {
    const name = await makeImplicitTeam({
      lead: [{ from: "dev-p1", text: "done", timestamp: "2026-09-03T02:00:00.000Z" }],
      "dev-p1": [{ from: "team-lead", text: '{"type":"task_assignment"}', timestamp: "2026-09-03T01:00:00.000Z" }],
    });
    const detail = await readTeamDetail(name) as any;
    expect(detail).not.toBeNull();
    expect(detail.name).toBe(name);
    expect(detail.implicit).toBe(true);
    expect(detail.memberCount).toBe(2);
    expect(detail.members.map((m: any) => m.name).sort()).toEqual(["dev-p1", "lead"]);
    // Sorted oldest-first across inboxes, with the recipient and parsed type attached
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[0].to).toBe("dev-p1");
    expect(detail.messages[0].parsedType).toBe("task_assignment");
    expect(detail.messages[1].to).toBe("lead");
    expect(detail.messages[1].parsedType).toBe("message");
  });

  it("skips a malformed inbox instead of failing the whole team", async () => {
    const name = await makeImplicitTeam({ lead: [{ from: "a", text: "hi", timestamp: "2026-09-03T01:00:00.000Z" }] });
    await writeFile(join(TEAMS_DIR, name, "inboxes", "broken.json"), "{not json", "utf-8");
    const detail = await readTeamDetail(name) as any;
    expect(detail).not.toBeNull();
    expect(detail.messages).toHaveLength(1);
    // The agent is still listed — its inbox exists, only its contents are unreadable
    expect(detail.members.map((m: any) => m.name).sort()).toEqual(["broken", "lead"]);
  });
});
