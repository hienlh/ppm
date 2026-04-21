import { describe, it, expect } from "bun:test";
import { generateCliReference } from "../../../scripts/lib/generate-cli-reference.ts";

describe("generateCliReference", () => {
  it("produces a markdown file with expected structure", async () => {
    const result = await generateCliReference("/ignored");
    expect(result).toHaveLength(1);
    expect(result[0]!.relPath).toBe("references/cli-reference.md");

    const md = result[0]!.content;
    expect(md).toContain("# PPM CLI Reference");
    expect(md).toContain("## Commands");
  });

  it("includes all top-level PPM commands", async () => {
    const result = await generateCliReference("/ignored");
    const md = result[0]!.content;

    // Sample of commands that must be present (not exhaustive — see plan for all 21)
    const expected = ["start", "stop", "status", "init", "logs", "upgrade", "db", "projects", "config", "export"];
    for (const cmd of expected) {
      expect(md).toContain(`\`ppm ${cmd}\``);
    }
  });

  it("includes options under a command (e.g. start --port)", async () => {
    const result = await generateCliReference("/ignored");
    const md = result[0]!.content;
    expect(md).toMatch(/`-p, --port <port>`/);
  });

  it("describes the export skill subcommand registered in phase 5", async () => {
    const result = await generateCliReference("/ignored");
    const md = result[0]!.content;
    expect(md).toContain("`ppm export skill`");
    expect(md).toContain("--install");
  });
});
