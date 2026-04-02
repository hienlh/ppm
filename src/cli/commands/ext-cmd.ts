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

function printTable(headers: string[], rows: string[][]): void {
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const sep = colWidths.map((w) => "-".repeat(w + 2)).join("+");
  const headerLine = headers.map((h, i) => ` ${h.padEnd(colWidths[i]!)} `).join("|");
  console.log(`+${sep}+`);
  console.log(`|${C.bold}${headerLine}${C.reset}|`);
  console.log(`+${sep}+`);
  for (const row of rows) {
    const line = row.map((cell, i) => ` ${(cell ?? "").padEnd(colWidths[i]!)} `).join("|");
    console.log(`|${line}|`);
  }
  console.log(`+${sep}+`);
}

export function registerExtCommands(program: Command): void {
  const ext = program.command("ext").description("Manage PPM extensions");

  ext
    .command("install <name>")
    .description("Install an extension from npm")
    .action(async (name: string) => {
      const { extensionService } = await import("../../services/extension.service.ts");
      try {
        console.log(`${C.dim}Installing ${name}...${C.reset}`);
        const manifest = await extensionService.install(name);
        console.log(`${C.green}✓${C.reset} Installed ${C.bold}${manifest.id}${C.reset}@${manifest.version}`);
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  ext
    .command("remove <name>")
    .description("Remove an installed extension")
    .action(async (name: string) => {
      const { extensionService } = await import("../../services/extension.service.ts");
      try {
        await extensionService.remove(name);
        console.log(`${C.green}✓${C.reset} Removed ${C.bold}${name}${C.reset}`);
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  ext
    .command("list")
    .description("List installed extensions")
    .action(async () => {
      const { extensionService } = await import("../../services/extension.service.ts");
      const extensions = extensionService.list();
      if (extensions.length === 0) {
        console.log(`${C.dim}No extensions installed.${C.reset}`);
        return;
      }
      const rows = extensions.map((e) => [
        e.id,
        e.version,
        e.enabled ? `${C.green}enabled${C.reset}` : `${C.dim}disabled${C.reset}`,
        e.activated ? `${C.green}active${C.reset}` : `${C.dim}inactive${C.reset}`,
      ]);
      printTable(["ID", "Version", "Enabled", "Status"], rows);
    });

  ext
    .command("enable <name>")
    .description("Enable an extension")
    .action(async (name: string) => {
      const { extensionService } = await import("../../services/extension.service.ts");
      try {
        await extensionService.setEnabled(name, true);
        console.log(`${C.green}✓${C.reset} Enabled ${C.bold}${name}${C.reset}`);
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  ext
    .command("disable <name>")
    .description("Disable an extension")
    .action(async (name: string) => {
      const { extensionService } = await import("../../services/extension.service.ts");
      try {
        await extensionService.setEnabled(name, false);
        console.log(`${C.green}✓${C.reset} Disabled ${C.bold}${name}${C.reset}`);
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  ext
    .command("dev <path>")
    .description("Symlink a local extension for development")
    .action(async (localPath: string) => {
      const { extensionService } = await import("../../services/extension.service.ts");
      try {
        const manifest = await extensionService.devLink(localPath);
        console.log(`${C.green}✓${C.reset} Dev-linked ${C.bold}${manifest.id}${C.reset} → ${localPath}`);
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
}
