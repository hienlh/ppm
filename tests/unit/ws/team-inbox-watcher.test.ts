import { describe, it, expect, beforeEach } from "bun:test";
import { extractTeamName, readTeamConfig, listTeams, readTeamDetail } from "../../../src/server/ws/team-inbox-watcher.ts";
import { join } from "path";
import { homedir } from "os";

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

  it("returns null when config.json not found", async () => {
    const result = await readTeamDetail("_fake_detail_team_" + Date.now());
    expect(result).toBeNull();
  });

  it("handles filesystem errors gracefully", async () => {
    const result = await readTeamDetail("");
    expect(result).toBeNull();
  });
});
