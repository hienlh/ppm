import type { Command } from "commander";
import { inAiChat } from "../../services/ai-chat-env.ts";
import { C, fail, projectRequest, resolveChatTarget, run, sessionSub, type ChatTarget } from "./chat-cmd-request.ts";

/**
 * `ppm chat` commands that change one chat or a project's chat list — rename, pin, tag, read
 * state, stop, delete, fork, account, clean-up. Each calls the route PPM's own screens call
 * (`chat-cmd-request.ts`), so the checks are the server's and every open PPM's list updates at
 * once. `stop` sends the chat socket's own stop frame (`chat-cmd-stop.ts`).
 */

type Tag = { id: number; name: string };

/** A tag given by name (case-blind) or by number, among the project's tags. */
async function tagIdOf(project: string, nameOrId: string): Promise<number> {
  const { tags } = await projectRequest<{ tags: Tag[] }>("GET", project, "/tags");
  const byName = tags.find((t) => t.name.toLowerCase() === nameOrId.toLowerCase());
  const byId = /^\d+$/.test(nameOrId) ? tags.find((t) => t.id === Number(nameOrId)) : undefined;
  return (byName ?? byId)?.id ?? fail(`No tag "${nameOrId}" in project ${project}; see \`ppm tags list -p ${project}\``);
}

const projectOption = ["-p, --project <name>", "The chat's project (default: the one PPM recorded for it)"] as const;

/** Registers a command on one chat: `<verb> <id> ...` with `-p`, resolving the chat first. */
function onChat(chat: Command, spec: string, description: string, act: (t: ChatTarget, ...args: string[]) => Promise<void>): void {
  chat
    .command(spec)
    .description(description)
    .option(...projectOption)
    // Commander passes the arguments, then the options, then the command itself.
    .action((...all: unknown[]) => {
      const opts = all[all.length - 2] as { project?: string };
      const [id, ...args] = all.slice(0, -2) as string[];
      return run(async () => act(await resolveChatTarget(id!, opts.project), ...args))();
    });
}

export function registerChatManageCommands(chat: Command): void {
  onChat(chat, "rename <session-id> <title>", "Rename a chat", async (t, title) => {
    await projectRequest("PATCH", t.project, sessionSub(t.id), { title });
    console.log(`${C.green}Renamed:${C.reset} ${t.id} → ${title}`);
  });

  onChat(chat, "pin <session-id>", "Pin a chat to the top of its project's list", async (t) => {
    await projectRequest("PUT", t.project, sessionSub(t.id, "/pin"));
    console.log(`${C.green}Pinned:${C.reset} ${t.id}`);
  });

  onChat(chat, "unpin <session-id>", "Unpin a chat", async (t) => {
    await projectRequest("DELETE", t.project, sessionSub(t.id, "/pin"));
    console.log(`${C.green}Unpinned:${C.reset} ${t.id}`);
  });

  onChat(chat, "tag <session-id> <tag>", "Tag a chat with one of its project's tags (by name or number)", async (t, tag) => {
    const tagId = await tagIdOf(t.project, tag);
    await projectRequest("PATCH", t.project, sessionSub(t.id, "/tag"), { tagId });
    console.log(`${C.green}Tagged:${C.reset} ${t.id} → ${tag}`);
  });

  onChat(chat, "untag <session-id>", "Remove a chat's tag", async (t) => {
    await projectRequest("DELETE", t.project, sessionSub(t.id, "/tag"));
    console.log(`${C.green}Untagged:${C.reset} ${t.id}`);
  });

  onChat(chat, "read <session-id>", "Mark a chat as read", async (t) => {
    await projectRequest("POST", t.project, sessionSub(t.id, "/read"));
    console.log(`${C.green}Marked read:${C.reset} ${t.id}`);
  });

  onChat(chat, "unread <session-id>", "Mark a chat as unread", async (t) => {
    await projectRequest("POST", t.project, sessionSub(t.id, "/unread"), { projectName: t.project });
    console.log(`${C.green}Marked unread:${C.reset} ${t.id}`);
  });

  onChat(chat, "stop <session-id>", "Stop the chat's running turn, as PPM's Stop button does", async (t) => {
    const { stopChatTurn } = await import("./chat-cmd-stop.ts");
    await stopChatTurn(t);
  });

  onChat(chat, "delete <session-id>", "Delete a chat; a running turn is stopped first, and nothing is deleted if it does not stop", async (t) => {
    const query = `?stopRunning=1${t.providerId ? `&providerId=${encodeURIComponent(t.providerId)}` : ""}`;
    await projectRequest("DELETE", t.project, `${sessionSub(t.id)}${query}`);
    console.log(`${C.green}Deleted:${C.reset} ${t.id}`);
  });

  onChat(chat, "fork <session-id>", "Start a new chat that carries this chat's title and settings", async (t) => {
    const query = t.providerId ? `?providerId=${encodeURIComponent(t.providerId)}` : "";
    const s = await projectRequest<{ id: string }>("POST", t.project, `${sessionSub(t.id, "/fork")}${query}`);
    console.log(`${C.green}Forked:${C.reset} ${t.id} → ${C.cyan}${s.id}${C.reset}`);
  });

  onChat(chat, "account <session-id> <account-id>", "Move a chat onto another account of its provider", async (t, accountId) => {
    await projectRequest("PUT", t.project, sessionSub(t.id, "/account"), { accountId });
    console.log(`${C.green}Account:${C.reset} ${t.id} → ${accountId}`);
  });

  chat
    .command("cleanup")
    .description("Delete a project's chats older than N days; pinned, manager, branched and running chats are kept")
    .requiredOption("--older-than <days>", "Age in days (at least 1)")
    .option("-p, --project <name>", "Project name or path (default: the current folder's project)")
    .option("--provider <id>", "Only this provider's chats (default: claude)")
    .action((opts: { olderThan: string; project?: string; provider?: string }) => run(async () => {
      // Advisory: the shell's approval card is the control; a clean-up sweeps many chats at once.
      if (inAiChat()) fail("Not run: an AI chat does not clean up chats in bulk. Give the user the command, or delete chats one at a time.");
      const days = Number(opts.olderThan);
      if (!Number.isInteger(days) || days < 1) fail("--older-than must be a whole number of days, at least 1");
      const { currentProjectName } = await import("./chat-cmd-request.ts");
      const project = await currentProjectName(opts.project);
      const provider = opts.provider ? `&providerId=${encodeURIComponent(opts.provider)}` : "";
      const r = await projectRequest<{ deleted: number; total: number }>("DELETE", project, `/chat/sessions?olderThanDays=${days}${provider}`);
      console.log(`${C.green}Deleted:${C.reset} ${r.deleted} of ${r.total} chats older than ${days} days in ${project}`);
    })());
}
