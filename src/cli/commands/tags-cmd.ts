import type { Command } from "commander";
import { C, currentProjectName, fail, projectRequest, run } from "./chat-cmd-request.ts";

/**
 * `ppm tags` — a project's chat tags, through the tag routes PPM's own screens call, so every open
 * PPM's chat list updates at once. A tag is named by its name (case-blind) or its number.
 */

type Tag = { id: number; name: string; color: string; sortOrder?: number };
type TagList = { tags: Tag[]; counts?: Record<string, number>; defaultTagId?: number | null };

const HEX_COLOR = /^#?[0-9a-fA-F]{6}$/;
const DEFAULT_COLOR = "#6b7280";

async function tagOf(project: string, nameOrId: string): Promise<Tag> {
  const { tags } = await projectRequest<TagList>("GET", project, "/tags");
  const found = tags.find((t) => t.name.toLowerCase() === nameOrId.toLowerCase())
    ?? (/^\d+$/.test(nameOrId) ? tags.find((t) => t.id === Number(nameOrId)) : undefined);
  return found ?? fail(`No tag "${nameOrId}" in project ${project}`);
}

function colorOf(raw: string): string {
  if (!HEX_COLOR.test(raw)) fail(`"${raw}" is not a colour: give #rrggbb`);
  return `#${raw.replace(/^#/, "").toLowerCase()}`;
}

export function registerTagsCommands(program: Command): void {
  const tags = program.command("tags").description("Manage a project's chat tags");
  const projectFlag = ["-p, --project <name>", "Project name or path (default: the current folder's project)"] as const;

  tags
    .command("list")
    .description("List a project's tags and how many chats carry each")
    .option(...projectFlag)
    .option("--json", "Print JSON")
    .action((opts: { project?: string; json?: boolean }) => run(async () => {
      const project = await currentProjectName(opts.project);
      const list = await projectRequest<TagList>("GET", project, "/tags");
      if (opts.json) {
        console.log(JSON.stringify(list, null, 2));
        return;
      }
      if (list.tags.length === 0) {
        console.log(`${C.yellow}No tags in ${project}.${C.reset}`);
        return;
      }
      for (const t of list.tags) {
        const isDefault = list.defaultTagId === t.id ? " (default)" : "";
        console.log(`${String(t.id).padStart(4)}  ${t.name}  ${C.dim}${t.color} · ${list.counts?.[t.id] ?? 0} chats${isDefault}${C.reset}`);
      }
    })());

  tags
    .command("add <name>")
    .description("Create a tag")
    .option(...projectFlag)
    .option("--color <hex>", "Colour as #rrggbb", DEFAULT_COLOR)
    .action((name: string, opts: { project?: string; color: string }) => run(async () => {
      const project = await currentProjectName(opts.project);
      const tag = await projectRequest<Tag>("POST", project, "/tags", { name, color: colorOf(opts.color) });
      console.log(`${C.green}Added:${C.reset} ${tag.name} (${tag.id}) in ${project}`);
    })());

  tags
    .command("rename <tag> <newName>")
    .description("Rename a tag")
    .option(...projectFlag)
    .action((tag: string, newName: string, opts: { project?: string }) => run(async () => {
      const project = await currentProjectName(opts.project);
      const t = await tagOf(project, tag);
      await projectRequest("PATCH", project, `/tags/${t.id}`, { name: newName });
      console.log(`${C.green}Renamed:${C.reset} ${t.name} → ${newName}`);
    })());

  tags
    .command("remove <tag>")
    .description("Delete a tag; its chats keep existing, untagged")
    .option(...projectFlag)
    .action((tag: string, opts: { project?: string }) => run(async () => {
      const project = await currentProjectName(opts.project);
      const t = await tagOf(project, tag);
      await projectRequest("DELETE", project, `/tags/${t.id}`);
      console.log(`${C.green}Removed:${C.reset} ${t.name}`);
    })());
}
