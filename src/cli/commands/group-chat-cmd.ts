import type { Command } from "commander";
import type { Group, GroupMember } from "../../types/group-chat.ts";
import { C, run } from "./chat-cmd-request.ts";
import { printTable } from "./cli-table.ts";
import { groupPart, groupRequest, refuseGroupChatInAiChat } from "./group-chat-cmd-request.ts";
import { registerGroupChatMemberCommands } from "./group-chat-cmd-members.ts";

/**
 * `ppm group-chat`: a project's group chats (AI agents talking in one thread), through the routes
 * the group chat panel calls (`group-chat-cmd-request.ts`). The panel has no rename; `set` changes
 * what its PATCH route takes, the reply limit.
 */

const when = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);

function printGroup(group: Group & { members: GroupMember[] }): void {
  console.log(`${group.name}  ${C.dim}${group.id}${C.reset}`);
  console.log(`  Status: ${group.status}   Max turns per reply burst: ${group.maxTurns}   Project: ${group.projectName}`);
  printTable(["Member id", "Name", "Role", "Model", "Status"], group.members.map((m) => [m.id, m.name, m.role, m.model ?? "", m.status]));
}

export function registerGroupChatCommands(program: Command): void {
  const group = program.command("group-chat").description("Group chats: AI agents talking with each other in one thread");

  group
    .command("list")
    .description("List a project's group chats")
    .option("-p, --project <name>", "Project name or path (default: the project the current folder is in)")
    .option("--json", "Print JSON")
    .action((opts: { project?: string; json?: boolean }) => run(async () => {
      const { resolveProject } = await import("../utils/project-resolver.ts");
      const project = resolveProject({ project: opts.project });
      const groups = await groupRequest<Group[]>("GET", `?projectPath=${encodeURIComponent(project.path)}`);
      if (opts.json) return void console.log(JSON.stringify(groups, null, 2));
      if (!groups.length) return void console.log(`${C.dim}No group chats in ${project.name}.${C.reset}`);
      printTable(["Id", "Name", "Status", "Max turns", "Created"], groups.map((g) => [g.id, g.name, g.status, String(g.maxTurns), when(g.createdAt)]));
    })());

  group
    .command("show <id>")
    .description("Show a group chat and its members (with the member ids `members edit` takes)")
    .option("--json", "Print JSON")
    .action((id: string, opts: { json?: boolean }) => run(async () => {
      const found = await groupRequest<Group & { members: GroupMember[] }>("GET", groupPart(id));
      if (opts.json) return void console.log(JSON.stringify(found, null, 2));
      printGroup(found);
    })());

  group
    .command("create <name>")
    .description("Create a group chat with a leader and members. Refused from an AI chat")
    .requiredOption("--leader <name>", "The leader's name")
    .option("--member <name>", "A member's name (repeat for each)", (v: string, all: string[]) => [...all, v], [] as string[])
    .option("--max-turns <n>", "Replies one message may set off (1-50)")
    .option("-p, --project <name>", "Project name or path (default: the project the current folder is in)")
    .option("--json", "Print JSON")
    .action((name: string, opts: { leader: string; member: string[]; maxTurns?: string; project?: string; json?: boolean }) => run(async () => {
      refuseGroupChatInAiChat("create");
      const { resolveProject } = await import("../utils/project-resolver.ts");
      const project = resolveProject({ project: opts.project });
      const members = [{ role: "leader", name: opts.leader }, ...opts.member.map((m) => ({ role: "member", name: m }))];
      const made = await groupRequest<Group>("POST", "", {
        projectName: project.name, projectPath: project.path, name, members,
        ...(opts.maxTurns !== undefined && { maxTurns: Number(opts.maxTurns) }),
      });
      if (opts.json) return void console.log(JSON.stringify(made, null, 2));
      console.log(`${C.green}✓${C.reset} Group chat "${made.name}" created: ${made.id}`);
    })());

  group
    .command("set <id>")
    .description("Change a group chat's settings")
    .requiredOption("--max-turns <n>", "Replies one message may set off (1-50)")
    .action((id: string, opts: { maxTurns: string }) => run(async () => {
      const updated = await groupRequest<Group>("PATCH", groupPart(id), { maxTurns: Number(opts.maxTurns) });
      console.log(`${C.green}✓${C.reset} ${updated.name}: at most ${updated.maxTurns} replies per message`);
    })());

  registerGroupChatMemberCommands(group);

  group
    .command("message <id> <text>")
    .description("Post a message to a group chat; its agents reply in the running PPM. Refused from an AI chat")
    .action((id: string, text: string) => run(async () => {
      refuseGroupChatInAiChat("message");
      await groupRequest("POST", `${groupPart(id)}/message`, { content: text }, true);
      console.log(`${C.green}✓${C.reset} Posted; the agents reply in the group chat panel`);
    })());

  group
    .command("stop <id>")
    .description("Stop a group chat's running replies (it is paused)")
    .action((id: string) => run(async () => {
      await groupRequest("POST", `${groupPart(id)}/stop`, {}, true);
      console.log(`${C.green}✓${C.reset} Group chat ${id} paused`);
    })());

  group
    .command("resume <id>")
    .description("Answer the last unanswered message of a paused group chat. Refused from an AI chat")
    .action((id: string) => run(async () => {
      refuseGroupChatInAiChat("resume");
      await groupRequest("POST", `${groupPart(id)}/resume`, {}, true);
      console.log(`${C.green}✓${C.reset} Group chat ${id} resumed`);
    })());

  group
    .command("delete <id>")
    .description("Delete a group chat; its members' transcripts are archived first")
    .action((id: string) => run(async () => {
      await groupRequest("DELETE", groupPart(id));
      console.log(`${C.green}✓${C.reset} Group chat ${id} deleted`);
    })());
}
