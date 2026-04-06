import { Command } from "commander";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

/**
 * `ppm bot memory` CLI — allows AI (via Bash tool) to save/list/forget
 * cross-project memories in the _global scope of clawbot_memories table.
 *
 * Usage from AI:
 *   ppm bot memory save "User prefers Vietnamese" --category preference
 *   ppm bot memory list
 *   ppm bot memory forget "Vietnamese"
 */
export function registerBotCommands(program: Command): void {
  const bot = program.command("bot").description("PPMBot utilities");

  const mem = bot.command("memory").description("Manage cross-project memories");

  mem
    .command("save <content>")
    .description("Save a cross-project memory")
    .option("-c, --category <cat>", "Category: fact|preference|decision|architecture|issue", "fact")
    .option("-s, --session <id>", "Session ID (optional)")
    .action(async (content: string, opts: { category: string; session?: string }) => {
      try {
        const { PPMBotMemory } = await import("../../services/ppmbot/ppmbot-memory.ts");
        const memory = new PPMBotMemory();
        const validCategories = ["fact", "decision", "preference", "architecture", "issue"];
        const category = validCategories.includes(opts.category) ? opts.category : "fact";
        const id = memory.saveOne("_global", content, category as any, opts.session);
        console.log(`${C.green}✓${C.reset} Saved memory #${id} [${category}]: ${content}`);
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  mem
    .command("list")
    .description("List active cross-project memories")
    .option("-l, --limit <n>", "Max results", "30")
    .option("--json", "Output as JSON")
    .action(async (opts: { limit: string; json?: boolean }) => {
      try {
        const { PPMBotMemory } = await import("../../services/ppmbot/ppmbot-memory.ts");
        const memory = new PPMBotMemory();
        const results = memory.getSummary("_global", Number(opts.limit) || 30);

        if (opts.json) {
          console.log(JSON.stringify(results, null, 2));
          return;
        }

        if (results.length === 0) {
          console.log(`${C.dim}No memories found.${C.reset}`);
          return;
        }

        for (const r of results) {
          const catTag = `${C.cyan}[${r.category}]${C.reset}`;
          console.log(`  #${r.id} ${catTag} ${r.content}`);
        }
        console.log(`\n${C.dim}${results.length} memories${C.reset}`);
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  mem
    .command("forget <topic>")
    .description("Delete memories matching a topic (FTS5 search)")
    .action(async (topic: string) => {
      try {
        const { PPMBotMemory } = await import("../../services/ppmbot/ppmbot-memory.ts");
        const memory = new PPMBotMemory();
        const deleted = memory.forget("_global", topic);
        if (deleted > 0) {
          console.log(`${C.green}✓${C.reset} Deleted ${deleted} memory(s) matching "${topic}"`);
        } else {
          console.log(`${C.yellow}No memories matched "${topic}"${C.reset}`);
        }
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
}
