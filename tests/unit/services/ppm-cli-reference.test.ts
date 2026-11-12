/**
 * The CLI reference the Assistant reads: generated from the real command tree (and failing here
 * when someone changes a command without regenerating it), every command placed in the routing
 * table, and headed by how to reach this instance and how to check that a command did.
 */
import { describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import {
  PPM_CLI_REFERENCE, TOOLS_INSTEAD_OF_CLI, cliReferenceSections, currentPpmInstance, ppmCliReference, ppmCliReferenceHeader,
} from "../../../src/services/assistant/ppm-cli-reference.ts";
import { CLI_COMMAND_ROUTING, DIRECT_SEEN_LIVE } from "../../../src/services/assistant/ppm-cli-routing.ts";
import { cliCommandPaths, generatePpmCliReference } from "../../../scripts/generate-ppm-cli-reference.ts";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";

describe("PPM_CLI_REFERENCE", () => {
  it("matches what the generator produces from the command tree now", async () => {
    // On failure: bun scripts/generate-ppm-cli-reference.ts --update
    // (the source literal ends with the newline before its closing backtick).
    expect(PPM_CLI_REFERENCE).toBe(`${await generatePpmCliReference()}\n`);
  }, 30_000);

  it("covers every command group, the ones the old parser missed included", () => {
    for (const group of ["Core Commands", "ppm projects", "ppm config", "ppm git", "ppm chat", "ppm db", "ppm autostart",
      "ppm cloud", "ppm ext", "ppm schedule", "ppm skills", "ppm jira", "ppm export"]) {
      expect(PPM_CLI_REFERENCE).toContain(group);
    }
    expect(PPM_CLI_REFERENCE).toContain("ppm git branch create");
    expect(PPM_CLI_REFERENCE).toContain("ppm db driver install");
    expect(PPM_CLI_REFERENCE).toContain("ppm restore [backup]");
  });
});

describe("the routing table", () => {
  it("places every command in the tree, and names no command that is gone", async () => {
    const paths = await cliCommandPaths();
    expect(paths.filter((p) => !(p in CLI_COMMAND_ROUTING))).toEqual([]);
    expect(Object.keys(CLI_COMMAND_ROUTING).filter((p) => !paths.includes(p))).toEqual([]);
    for (const p of DIRECT_SEEN_LIVE) expect(CLI_COMMAND_ROUTING[p]).toBe("direct-pending");
  }, 30_000);

  it("sends config set through the server and keeps the process commands direct", () => {
    expect(CLI_COMMAND_ROUTING["config set"]).toBe("server");
    for (const p of ["start", "init", "backup", "restore", "autostart enable", "upgrade", "export skill", "skills list", "cloud login"]) {
      expect({ p, k: CLI_COMMAND_ROUTING[p] }).toEqual({ p, k: "direct-allowed" });
    }
  });
});

describe("the header", () => {
  const base = { ppmDir: "/home/u/.ppm", dbFile: "/home/u/.ppm/ppm.db", profile: null, command: "ppm" };

  it("names this instance and the target line a command prints, instead of warning about profiles", () => {
    const header = ppmCliReferenceHeader(base);
    expect(header).toContain("/home/u/.ppm (database ppm.db)");
    expect(header).toContain("Invoke the CLI as: ppm");
    expect(header).toContain("`→ PPM default (ppm.db) at 127.0.0.1:<port>`");
    expect(header).toContain("do not pass --profile or --instance");
    const dev = ppmCliReferenceHeader({ ...base, dbFile: "/home/u/.ppm/ppm.dev.db", profile: "dev" });
    expect(dev).toContain("`→ PPM dev (ppm.dev.db) at 127.0.0.1:<port>`");
    expect(dev).not.toContain("WARNING");
  });

  it("sorts commands by how they reach PPM", () => {
    const header = ppmCliReferenceHeader(base);
    const server = header.indexOf("## Commands that go through the running server");
    const live = header.indexOf("the running server picks up at once");
    const direct = header.indexOf("## Commands that write PPM's data directly\n");
    const none = header.indexOf("## Commands that need no server");
    expect([server, live, direct, none].every((i) => i > -1)).toBe(true);
    expect(header.slice(server, live)).toContain("ppm config set");
    expect(header.slice(live, direct)).toContain("ppm projects add");
    expect(header.slice(direct, none)).not.toContain("ppm projects add");
    expect(header.slice(direct, none)).toContain("ppm db add");
    expect(header.slice(none)).toContain("ppm backup");
  });

  it("sends git, schedules and tunnels to the Assistant's tools first, each tool listed once", () => {
    const header = ppmCliReferenceHeader(base);
    const start = header.indexOf("## Use the Assistant's tools instead");
    const end = header.indexOf("## Commands that go through the running server");
    const instead = header.slice(start, end);
    for (const name of TOOLS_INSTEAD_OF_CLI.flatMap((g) => g.tools)) {
      // Whole words: `git_branch` must not count inside `git_branches`.
      expect({ name, n: instead.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0 }).toEqual({ name, n: 1 });
    }
    expect(header).toContain("- schedule run-now: prefer the schedule_run_now tool");
  });

  it("tells a Codex session to escalate ppm commands out of its sandbox, and nobody else", () => {
    expect(ppmCliReferenceHeader(base, { provider: "codex" })).toContain('sandbox_permissions: "require_escalated"');
    expect(ppmCliReferenceHeader(base, { provider: "claude" })).not.toContain("require_escalated");
  });
});

describe("ppmCliReference", () => {
  const instance = currentPpmInstance();

  it("describes the running instance: this test's own folder", () => {
    expect(instance.ppmDir).toBe(getPpmDir());
    expect(instance.command).toContain("index.ts");
  });

  it("answers an index of groups by default, and one group's commands when asked", () => {
    const index = ppmCliReference(instance);
    expect(index).toContain("## Command groups");
    expect(index).toContain("- config: Get or set PPM configuration");
    expect(index).not.toContain("ppm config set <key> <value>");
    const config = ppmCliReference(instance, { group: "config" });
    expect(config).toContain("ppm config set <key> <value>");
    expect(config).not.toContain("## ppm db");
    expect(ppmCliReference(instance, { group: "core" })).toContain("ppm start");
    expect(ppmCliReference(instance, { group: "nope" })).toContain('No command group "nope"');
  });

  it("cuts the reference into one section per group", () => {
    const names = [...cliReferenceSections().keys()];
    expect(names[0]).toBe("core");
    expect(names).toEqual(expect.arrayContaining(["projects", "config", "git", "db", "schedule", "tips"]));
  });
});
