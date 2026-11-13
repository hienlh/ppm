import type { Command } from "commander";
import { ppmApiRequest } from "../utils/settings-request.ts";
import { C, run } from "./chat-cmd-request.ts";
import { printTable } from "./cli-table.ts";

/**
 * `ppm teams`: the Claude agent teams the Teams panel shows (`~/.claude/teams/<name>`), through
 * `/api/teams` on the running PPM — or the same routes here when none runs. `delete` asks the
 * route for the team first, so a name that is no team is an error rather than a silent success
 * (the delete route removes whatever folder it is given and answers ok).
 */

interface TeamRow { name?: string; implicit?: boolean; members?: unknown[]; memberCount?: number; description?: string }

const teamPart = (name: string) => `/teams/${encodeURIComponent(name)}`;

export function registerTeamsCommands(program: Command): void {
  const teams = program.command("teams").description("Claude agent teams: list or delete them");

  teams
    .command("list")
    .description("List the agent teams on this machine")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => run(async () => {
      const rows = await ppmApiRequest<TeamRow[]>("GET", "/teams");
      if (opts.json) return void console.log(JSON.stringify(rows, null, 2));
      if (!rows.length) return void console.log(`${C.dim}No agent teams.${C.reset}`);
      printTable(["Name", "Members", "Kind", "Description"], rows.map((t) => [
        t.name ?? "", String(Array.isArray(t.members) ? t.members.length : t.memberCount ?? 0), t.implicit ? "implicit" : "configured", t.description ?? "",
      ]));
    })());

  teams
    .command("delete <name>")
    .description("Delete an agent team's folder (its config and inboxes)")
    .action((name: string) => run(async () => {
      await ppmApiRequest("GET", teamPart(name));
      await ppmApiRequest("DELETE", teamPart(name));
      console.log(`${C.green}✓${C.reset} Team ${name} deleted`);
    })());
}
