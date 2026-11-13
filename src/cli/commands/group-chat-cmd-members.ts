import type { Command } from "commander";
import type { GroupMember } from "../../types/group-chat.ts";
import { C, fail, run } from "./chat-cmd-request.ts";
import { groupPart, groupRequest, refuseGroupChatInAiChat } from "./group-chat-cmd-request.ts";

/**
 * `ppm group-chat members add|edit|remove`: the group chat panel's member routes. The route keeps
 * one leader: making a member leader demotes the current one, and a leader is neither demoted nor
 * removed until another member leads. `add` is refused from an AI chat: a new member takes part in
 * the next turns.
 */

interface MemberOpts { leader?: boolean; persona?: string; model?: string; color?: string; name?: string }

const memberPart = (id: string, memberId: string) => `${groupPart(id)}/members/${encodeURIComponent(memberId)}`;

const withDetails = (cmd: Command) => cmd
  .option("--persona <text>", "Who the member is, in a sentence or two")
  .option("--model <model>", "The model it runs on (default: the provider's)")
  .option("--color <hex>", "Its colour in the feed (#rrggbb)");

export function registerGroupChatMemberCommands(group: Command): void {
  const members = group.command("members").description("Add, change or remove a group chat's members");

  withDetails(members.command("add <id> <name>").description("Add a member to a group chat. Refused from an AI chat"))
    .option("--leader", "Make it the leader (the current leader becomes a member)")
    .action((id: string, name: string, opts: MemberOpts) => run(async () => {
      refuseGroupChatInAiChat("members add");
      const added = await groupRequest<GroupMember>("POST", `${groupPart(id)}/members`, {
        name, role: opts.leader ? "leader" : "member", persona: opts.persona, model: opts.model, color: opts.color,
      });
      console.log(`${C.green}✓${C.reset} ${added.name} joined as ${added.role}: ${added.id}`);
    })());

  withDetails(members.command("edit <id> <memberId>").description("Change a member; what is not given is kept (\"\" clears persona, model or colour)"))
    .option("--name <name>", "A new name")
    .option("--leader", "Make it the leader (the current leader becomes a member)")
    .action((id: string, memberId: string, opts: MemberOpts) => run(async () => {
      const patch = {
        ...(opts.name !== undefined && { name: opts.name }),
        ...(opts.persona !== undefined && { persona: opts.persona }),
        ...(opts.model !== undefined && { model: opts.model }),
        ...(opts.color !== undefined && { color: opts.color }),
        ...(opts.leader && { role: "leader" }),
      };
      if (!Object.keys(patch).length) fail("Nothing to change: give --name, --persona, --model, --color or --leader");
      const updated = await groupRequest<GroupMember>("PATCH", memberPart(id, memberId), patch);
      console.log(`${C.green}✓${C.reset} ${updated.name} (${updated.role}) updated`);
    })());

  members
    .command("remove <id> <memberId>")
    .description("Remove a member (not the leader); its transcript is archived first")
    .action((id: string, memberId: string) => run(async () => {
      await groupRequest("DELETE", memberPart(id, memberId));
      console.log(`${C.green}✓${C.reset} Member ${memberId} removed`);
    })());
}
