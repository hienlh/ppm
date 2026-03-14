import { Command } from "commander";
import * as readline from "node:readline";
import type { ChatEvent } from "../../types/chat.ts";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
};

function printTable(headers: string[], rows: string[][]): void {
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const sep = colWidths.map((w) => "-".repeat(w + 2)).join("+");
  const headerLine = headers
    .map((h, i) => ` ${h.padEnd(colWidths[i]!)} `)
    .join("|");
  console.log(`+${sep}+`);
  console.log(`|${C.bold}${headerLine}${C.reset}|`);
  console.log(`+${sep}+`);
  for (const row of rows) {
    const line = row.map((cell, i) => ` ${(cell ?? "").padEnd(colWidths[i]!)} `).join("|");
    console.log(`|${line}|`);
  }
  console.log(`+${sep}+`);
}

async function streamEvents(
  events: AsyncIterable<ChatEvent>,
  onApproval?: (requestId: string, tool: string, input: unknown) => Promise<boolean>,
): Promise<void> {
  for await (const event of events) {
    switch (event.type) {
      case "text":
        process.stdout.write(event.content);
        break;
      case "tool_use":
        process.stdout.write(`\n${C.dim}[Tool: ${event.tool}]${C.reset}\n`);
        break;
      case "tool_result":
        // silent in non-interactive mode
        break;
      case "approval_request":
        if (onApproval) {
          const approved = await onApproval(event.requestId, event.tool, event.input);
          if (!approved) {
            process.stdout.write(`${C.yellow}[Tool denied]${C.reset}\n`);
          }
        }
        break;
      case "error":
        process.stderr.write(`\n${C.red}Error: ${event.message}${C.reset}\n`);
        break;
      case "done":
        process.stdout.write("\n");
        break;
    }
  }
}

function promptApproval(tool: string, input: unknown): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const inputStr = typeof input === "object" ? JSON.stringify(input) : String(input);
    rl.question(
      `${C.yellow}[Tool: ${tool}]${C.reset} ${C.dim}${inputStr.slice(0, 80)}${C.reset}\nAllow? (y/n): `,
      (answer) => {
        rl.close();
        resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
      },
    );
  });
}

export function registerChatCommands(program: Command): void {
  const chat = program.command("chat").description("Manage AI chat sessions");

  chat
    .command("list")
    .description("List all chat sessions")
    .option("-p, --project <name>", "Filter by project name")
    .action(async (options: { project?: string }) => {
      try {
        const { chatService } = await import("../../services/chat.service.ts");
        const sessions = await chatService.listSessions();

        const filtered = options.project
          ? sessions.filter((s) => s.projectName === options.project)
          : sessions;

        if (filtered.length === 0) {
          console.log(`${C.yellow}No sessions found.${C.reset}`);
          return;
        }

        const rows = filtered.map((s) => [
          s.id.slice(0, 8) + "...",
          s.providerId,
          s.title || "(untitled)",
          s.projectName ?? "-",
          new Date(s.createdAt).toLocaleString(),
        ]);

        printTable(["ID", "Provider", "Title", "Project", "Date"], rows);
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  chat
    .command("create")
    .description("Create a new chat session")
    .option("-p, --project <name>", "Project name or path")
    .option("--provider <provider>", "AI provider (default: claude)")
    .action(async (options: { project?: string; provider?: string }) => {
      try {
        const { chatService } = await import("../../services/chat.service.ts");

        let projectName: string | undefined;
        let projectPath: string | undefined;
        if (options.project) {
          const { resolveProject } = await import("../utils/project-resolver.ts");
          const proj = resolveProject(options);
          projectName = proj.name;
          projectPath = proj.path;
        }

        const session = await chatService.createSession(options.provider, {
          projectName,
          projectPath,
        });

        console.log(`${C.green}Created session:${C.reset} ${C.cyan}${session.id}${C.reset}`);
        console.log(`Provider: ${session.providerId}`);
        if (projectName) console.log(`Project: ${projectName}`);
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  chat
    .command("send <session-id> <message>")
    .description("Send a message and stream response to stdout")
    .option("-p, --project <name>", "Project name or path")
    .action(async (sessionId: string, message: string, options: { project?: string }) => {
      try {
        const { chatService } = await import("../../services/chat.service.ts");
        const { providerRegistry } = await import("../../providers/registry.ts");

        // Determine provider from session listing
        const sessions = await chatService.listSessions();
        const session = sessions.find((s) => s.id === sessionId || s.id.startsWith(sessionId));
        if (!session) {
          console.error(`${C.red}Error:${C.reset} Session not found: ${sessionId}`);
          process.exit(1);
        }

        const events = chatService.sendMessage(session.providerId, session.id, message);
        await streamEvents(events);
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  chat
    .command("resume <session-id>")
    .description("Resume an interactive chat session")
    .option("-p, --project <name>", "Project name or path")
    .action(async (sessionId: string, _options: { project?: string }) => {
      try {
        const { chatService } = await import("../../services/chat.service.ts");

        const sessions = await chatService.listSessions();
        const session = sessions.find((s) => s.id === sessionId || s.id.startsWith(sessionId));
        if (!session) {
          console.error(`${C.red}Error:${C.reset} Session not found: ${sessionId}`);
          process.exit(1);
        }

        console.log(`${C.green}Resuming session:${C.reset} ${session.id}`);
        console.log(`${C.dim}Type your message and press Enter. Ctrl+C to exit.${C.reset}\n`);

        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          terminal: true,
        });

        const askQuestion = (): void => {
          rl.question(`${C.bold}${C.blue}You:${C.reset} `, async (userInput) => {
            const trimmed = userInput.trim();
            if (!trimmed) {
              askQuestion();
              return;
            }

            process.stdout.write(`${C.bold}${C.magenta}Claude:${C.reset} `);

            try {
              const events = chatService.sendMessage(session.providerId, session.id, trimmed);
              await streamEvents(events, async (_requestId, tool, input) => {
                const approved = await promptApproval(tool, input);
                return approved;
              });
            } catch (err) {
              console.error(`\n${C.red}Error:${C.reset}`, (err as Error).message);
            }

            askQuestion();
          });
        };

        rl.on("close", () => {
          console.log(`\n${C.dim}Session ended.${C.reset}`);
          process.exit(0);
        });

        askQuestion();
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  chat
    .command("delete <session-id>")
    .description("Delete a chat session")
    .action(async (sessionId: string) => {
      try {
        const { chatService } = await import("../../services/chat.service.ts");

        const sessions = await chatService.listSessions();
        const session = sessions.find((s) => s.id === sessionId || s.id.startsWith(sessionId));
        if (!session) {
          console.error(`${C.red}Error:${C.reset} Session not found: ${sessionId}`);
          process.exit(1);
        }

        await chatService.deleteSession(session.providerId, session.id);
        console.log(`${C.green}Deleted session:${C.reset} ${session.id}`);
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });
}
