import type { Command } from "commander";
import { inAiChat } from "../../services/ai-chat-env.ts";
import type { ManagerAssignCheck, ManagerChatSummary } from "../../shared/assistant-managers.ts";
import { ppmApiRequest } from "../utils/settings-request.ts";
import { C, currentProjectName, fail, resolveChatTarget, run } from "./chat-cmd-request.ts";
import { printTable } from "./cli-table.ts";

/**
 * `ppm manager`: each project's manager chat — the chat PPM Assistant messages without asking —
 * through `/api/assistant/managers`, the routes the session list's "Set as manager chat" and
 * "Unset manager chat" call, so the rules files, the checks and every open PPM's badges are the
 * screen's. Server only: the role is checked against the live chats and announced by the running
 * PPM. `assign` and `unassign` are refused from an AI chat (advisory): the PPM Assistant has
 * `manager_assign` and `manager_unassign`, which show the user a card.
 */

const SERVER_ONLY = "Manager chats are set in the running PPM.";
const managersPath = (project: string) => `/assistant/managers/${encodeURIComponent(project)}`;
const api = <T>(method: string, path: string, body?: unknown) => ppmApiRequest<T>(method, path, body, { serverOnly: SERVER_ONLY });

function refuseInAiChat(command: string, tool: string): void {
  if (!inAiChat()) return;
  fail(`ppm manager ${command} is refused here from an AI chat: the manager chat is the one PPM Assistant messages without asking. `
    + `The PPM Assistant uses its ${tool} tool (the user sees a card); otherwise the user does it from the chat's menu in PPM, or runs the command.`);
}

export function registerManagerCommands(program: Command): void {
  const manager = program.command("manager").description("Each project's manager chat: the chat PPM Assistant messages without asking");
  const chatProjectFlag = ["-p, --project <name>", "Project name or path (default: the project PPM recorded for the chat)"] as const;
  const projectFlag = ["-p, --project <name>", "Project name or path (default: the current folder's project)"] as const;

  manager
    .command("list")
    .description("List every project's manager chat")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => run(async () => {
      const { managers } = await api<{ managers: ManagerChatSummary[] }>("GET", "/assistant/managers");
      if (opts.json) {
        console.log(JSON.stringify(managers, null, 2));
        return;
      }
      if (managers.length === 0) {
        console.log(`${C.yellow}No manager chats yet.${C.reset} Set one with \`ppm manager assign <session> -p <project>\` or from a chat's menu in PPM.`);
        return;
      }
      printTable(["Project", "Chat", "Session", "State", "Mode"], managers.map((m) => [
        m.projectName, m.title ?? "(untitled)", m.sessionId, m.phase, m.permissionMode,
      ]));
    })());

  manager
    .command("assign <session>")
    .description("Make an existing Claude chat its project's manager chat. Refused from an AI chat (use manager_assign)")
    .option(...chatProjectFlag)
    .option("--replace", "Take the role from the project's current manager chat")
    .action((session: string, opts: { project?: string; replace?: boolean }) => run(async () => {
      refuseInAiChat("assign", "manager_assign");
      const chat = await resolveChatTarget(session, opts.project);
      const project = chat.project;
      const check = await api<ManagerAssignCheck>("GET", `${managersPath(project)}/check?sessionId=${encodeURIComponent(chat.id)}`);
      if (check.already) {
        console.log(`${C.dim}${chat.id} already is the manager chat of ${project}.${C.reset}`);
        return;
      }
      if (check.replaces && !opts.replace) {
        fail(`${project} already has a manager chat: "${check.replaces.title ?? "(untitled)"}" (${check.replaces.sessionId}). `
          + "Pass --replace to take the role from it, or run `ppm manager unassign` first.");
      }
      const done = await api<{ sessionId: string; replaced: string | null }>("PUT", managersPath(project), { sessionId: chat.id });
      console.log(`${C.green}Manager chat of ${project}:${C.reset} ${done.sessionId}${done.replaced ? ` (replaces ${done.replaced}, which keeps its history)` : ""}`);
      if (check.permissionMode === "bypassPermissions") console.log(`${C.yellow}This chat runs without approval prompts.${C.reset}`);
    })());

  manager
    .command("unassign")
    .description("Stop a project's manager chat being the manager; the chat is kept. Refused from an AI chat (use manager_unassign)")
    .option(...projectFlag)
    .action((opts: { project?: string }) => run(async () => {
      refuseInAiChat("unassign", "manager_unassign");
      const project = await currentProjectName(opts.project);
      const { removed } = await api<{ removed: boolean }>("DELETE", managersPath(project));
      console.log(removed
        ? `${C.green}Unassigned:${C.reset} ${project} has no manager chat now; the chat is kept.`
        : `${C.dim}${project} had no manager chat; nothing changed.${C.reset}`);
    })());
}
