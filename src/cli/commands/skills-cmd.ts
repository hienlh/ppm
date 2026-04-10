import { Command } from "commander";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
};

export function registerSkillsCommands(program: Command): void {
  const skills = program
    .command("skills")
    .description("Manage and inspect discovered skills & commands")
    .option("--project <path>", "Project path", process.cwd());

  // Default action (no subcommand) → list
  skills.action(async (opts) => { await listAction(opts); });

  skills
    .command("list")
    .description("List all discovered skills and commands")
    .option("--json", "JSON output")
    .option("--project <path>", "Project path", process.cwd())
    .action(async (opts) => { await listAction({ ...skills.opts(), ...opts }); });

  skills
    .command("search <query>")
    .description("Fuzzy search skills and commands")
    .option("--json", "JSON output")
    .option("--project <path>", "Project path", process.cwd())
    .action(async (query: string, opts) => {
      const merged = { ...skills.opts(), ...opts };
      const { listSlashItems, searchSlashItems } = await import("../../services/slash-discovery/index.ts");
      const items = listSlashItems(merged.project ?? process.cwd());
      const results = searchSlashItems(items, query);
      if (merged.json) { console.log(JSON.stringify(results, null, 2)); return; }
      if (results.length === 0) {
        console.log(`${C.yellow}No matches for "${query}"${C.reset}`);
        return;
      }
      console.log(`\n${C.bold}Search results for "${query}"${C.reset} (${results.length} matches)\n`);
      for (const item of results) {
        const typeLabel = item.type === "builtin" ? `${C.green}builtin${C.reset}` : item.type === "skill" ? `${C.cyan}skill${C.reset}` : `${C.yellow}command${C.reset}`;
        console.log(`  ${C.bold}/${item.name}${C.reset}  [${typeLabel}]  ${C.dim}${item.description || ""}${C.reset}`);
      }
      console.log();
    });

  skills
    .command("info <name>")
    .description("Show detailed info for a specific skill")
    .option("--json", "JSON output")
    .option("--project <path>", "Project path", process.cwd())
    .action(async (name: string, opts) => {
      const merged = { ...skills.opts(), ...opts };
      const { listSlashItemsDetailed } = await import("../../services/slash-discovery/index.ts");
      const result = listSlashItemsDetailed(merged.project ?? process.cwd());
      const item = result.active.find((i) => i.name === name)
        ?? result.shadowed.find((i) => i.name === name);
      if (!item) {
        console.error(`${C.red}✗${C.reset} Skill "${name}" not found`);
        process.exit(1);
      }
      if (merged.json) { console.log(JSON.stringify(item, null, 2)); return; }
      console.log(`\n${C.bold}/${item.name}${C.reset}`);
      console.log(`  Type:        ${item.type}`);
      console.log(`  Source:      ${item.source}`);
      console.log(`  Scope:       ${item.scope}`);
      console.log(`  Path:        ${item.filePath || "(built-in)"}`);
      console.log(`  Description: ${item.description || "(none)"}`);
      if ("shadowedBy" in item) {
        console.log(`  ${C.yellow}Shadowed by:${C.reset} ${(item as any).shadowedBy.source}`);
      }
      console.log();
    });
}

async function listAction(opts: any): Promise<void> {
  const { listSlashItemsDetailed } = await import("../../services/slash-discovery/index.ts");
  const result = listSlashItemsDetailed(opts.project ?? process.cwd());

  if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }

  // Roots section
  if (result.roots.length > 0) {
    console.log(`\n${C.bold}Skill Roots:${C.reset}`);
    for (const root of result.roots) {
      console.log(`  ${root.path}  ${C.dim}(${root.source})${C.reset}`);
    }
  }

  const skills = result.active.filter((i) => i.type === "skill");
  const commands = result.active.filter((i) => i.type === "command");
  const builtins = result.active.filter((i) => i.type === "builtin");
  console.log(`\n${skills.length} skills, ${commands.length} commands, ${builtins.length} built-in (${result.shadowed.length} shadowed)\n`);

  // Active items table
  const nonBuiltin = result.active.filter((i) => i.type !== "builtin");
  if (nonBuiltin.length > 0) {
    const nameW = Math.max(4, ...nonBuiltin.map((i) => i.name.length));
    const typeW = 7;
    const srcW = Math.max(6, ...nonBuiltin.map((i) => i.source.length));
    const header = `  ${"Name".padEnd(nameW)}  ${"Type".padEnd(typeW)}  ${"Source".padEnd(srcW)}  Description`;
    console.log(`${C.bold}${header}${C.reset}`);
    console.log(`  ${"-".repeat(nameW)}  ${"-".repeat(typeW)}  ${"-".repeat(srcW)}  ${"-".repeat(20)}`);
    for (const item of nonBuiltin) {
      const typeLabel = item.type === "skill" ? "skill" : "command";
      console.log(`  ${item.name.padEnd(nameW)}  ${typeLabel.padEnd(typeW)}  ${item.source.padEnd(srcW)}  ${item.description || ""}`);
    }
  }

  // Shadowed items
  if (result.shadowed.length > 0) {
    console.log(`\n${C.yellow}Shadowed:${C.reset}`);
    for (const item of result.shadowed) {
      console.log(`  ${item.name}  [${item.type}]  ${item.source}  ${C.dim}← shadowed by ${item.shadowedBy.source}${C.reset}`);
    }
  }
  console.log();
}
