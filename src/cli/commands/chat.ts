import type { Command } from "commander";
import * as readline from "readline";
import { configService } from "../../services/config.service.ts";
import { ProjectService } from "../../services/project.service.ts";
import { chatService } from "../../services/chat.service.ts";
import { resolveProject } from "../utils/project-resolver.ts";
import type { ChatEvent } from "../../types/chat.ts";

const G = "\x1b[32m";
const C = "\x1b[36m";
const Y = "\x1b[33m";
const R = "\x1b[31m";
const RESET = "\x1b[0m";

function pad(str: string, width: number): string {
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}

function getProjectPath(opts: { project?: string }): string | undefined {
  configService.load();
  const ps = new ProjectService(configService);
  try {
    return resolveProject(ps, opts.project).path;
  } catch {
    return undefined;
  }
}

async function streamEvents(events: AsyncIterable<ChatEvent>): Promise<void> {
  for await (const event of events) {
    switch (event.type) {
      case "text":
        process.stdout.write(event.content);
        break;
      case "tool_use":
        console.log(`\n${Y}[tool]${RESET} ${event.tool}`);
        break;
      case "tool_result":
        console.log(`${C}[result]${RESET} ${event.output}`);
        break;
      case "error":
        console.error(`${R}[error]${RESET} ${event.message}`);
        break;
      case "done":
        process.stdout.write("\n");
        break;
    }
  }
}

export function registerChatCommands(program: Command): void {
  const chat = program.command("chat").description("AI chat session management");

  chat
    .command("list")
    .description("List chat sessions")
    .option("-p, --project <name>", "Project name or path")
    .action(async (opts: { project?: string }) => {
      getProjectPath(opts); // ensure config loaded
      const sessions = await chatService.listSessions();
      if (sessions.length === 0) {
        console.log("No sessions found.");
        return;
      }
      const idW = Math.max(2, ...sessions.map((s) => s.id.length));
      const titleW = Math.max(5, ...sessions.map((s) => s.title.length));
      console.log(`${pad("ID", idW)}  ${pad("TITLE", titleW)}  MSGS  CREATED`);
      console.log(`${"-".repeat(idW)}  ${"-".repeat(titleW)}  ----  -------`);
      for (const s of sessions) {
        console.log(
          `${pad(s.id, idW)}  ${pad(s.title, titleW)}  ${String(s.messageCount).padStart(4)}  ${s.createdAt}`
        );
      }
    });

  chat
    .command("create")
    .description("Create a new chat session")
    .option("-p, --project <name>", "Project name or path")
    .option("--provider <id>", "AI provider ID")
    .option("--title <title>", "Session title")
    .action(async (opts: { project?: string; provider?: string; title?: string }) => {
      const projectPath = getProjectPath(opts);
      const session = await chatService.createSession(
        { projectPath, title: opts.title },
        opts.provider
      );
      console.log(`${G}Created session:${RESET} ${session.id}`);
      console.log(`Title: ${session.title}`);
    });

  chat
    .command("send <session-id> <message>")
    .description("Send a message to a session and stream response")
    .option("-p, --project <name>", "Project name or path")
    .option("--provider <id>", "AI provider ID")
    .action(async (sessionId: string, message: string, opts: { project?: string; provider?: string }) => {
      getProjectPath(opts);
      const events = chatService.sendMessage(sessionId, message, opts.provider);
      await streamEvents(events);
    });

  chat
    .command("resume <session-id>")
    .description("Resume interactive session (readline loop)")
    .option("-p, --project <name>", "Project name or path")
    .option("--provider <id>", "AI provider ID")
    .action(async (sessionId: string, opts: { project?: string; provider?: string }) => {
      getProjectPath(opts);
      await chatService.resumeSession(sessionId, opts.provider);

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `${C}you>${RESET} `,
      });

      rl.prompt();

      rl.on("line", async (line: string) => {
        const msg = line.trim();
        if (!msg) { rl.prompt(); return; }
        if (msg === "/exit" || msg === "/quit") { rl.close(); return; }

        rl.pause();
        try {
          const events = chatService.sendMessage(sessionId, msg, opts.provider);
          process.stdout.write(`${G}assistant>${RESET} `);
          await streamEvents(events);
        } catch (err) {
          console.error(`${R}Error:${RESET} ${err}`);
        }
        rl.resume();
        rl.prompt();
      });

      rl.on("close", () => {
        console.log("Session ended.");
        process.exit(0);
      });
    });

  chat
    .command("delete <session-id>")
    .description("Delete a chat session")
    .option("-p, --project <name>", "Project name or path")
    .option("--provider <id>", "AI provider ID")
    .action(async (sessionId: string, opts: { project?: string; provider?: string }) => {
      getProjectPath(opts);
      await chatService.deleteSession(sessionId, opts.provider);
      console.log(`${R}Deleted session:${RESET} ${sessionId}`);
    });
}
