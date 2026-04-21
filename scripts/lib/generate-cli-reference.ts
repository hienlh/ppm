// Walk the Commander tree produced by buildProgram() and emit a markdown reference.
// No side effects — buildProgram() assembles commands but does not invoke any `action` callback.
import type { Command, Option } from "commander";
import { buildProgram } from "../../src/index.ts";
import type { OutputFile } from "./write-output.ts";

export async function generateCliReference(_root: string): Promise<OutputFile[]> {
  const program = await buildProgram();
  const header = "# PPM CLI Reference\n\n_Auto-generated. Do not edit._\n\nRoot binary: `ppm`. Run `ppm <command> --help` for full usage.\n";

  // Global options section (root-level options only, excluding implicit -V/-h).
  const globalOptsMd = renderRootOptions(program);

  // Child commands sorted alphabetically for deterministic output.
  const children = [...program.commands].filter((c) => !isHidden(c)).sort((a, b) => a.name().localeCompare(b.name()));
  const sections = children.map((c) => renderCommand(c, 2)).join("\n");

  const content = `${header}\n${globalOptsMd}\n## Commands\n\n${sections}`;
  return [{ relPath: "references/cli-reference.md", content }];
}

function isHidden(cmd: Command): boolean {
  // Commander's internal flag. Public typings omit `_hidden`; access defensively.
  return Boolean((cmd as unknown as { _hidden?: boolean })._hidden);
}

function renderRootOptions(program: Command): string {
  const opts = program.options.filter((o) => !o.hidden);
  if (opts.length === 0) return "";
  const rows = opts.map((o) => `- \`${o.flags}\` — ${o.description || "_(no description)_"}`).join("\n");
  return `## Global Options\n\n${rows}\n`;
}

function renderCommand(cmd: Command, depth: number): string {
  const heading = "#".repeat(Math.min(depth, 6));
  const pathName = commandPath(cmd);
  const desc = cmd.description() || "_(no description)_";

  const parts: string[] = [];
  parts.push(`${heading} \`ppm ${pathName}\``);
  parts.push("");
  parts.push(desc);

  const opts = cmd.options.filter((o: Option) => !o.hidden);
  if (opts.length > 0) {
    parts.push("");
    parts.push("**Options:**");
    for (const o of opts) {
      const d = o.description || "_(no description)_";
      const def = o.defaultValue !== undefined ? ` (default: \`${JSON.stringify(o.defaultValue)}\`)` : "";
      parts.push(`- \`${o.flags}\` — ${d}${def}`);
    }
  }

  const usage = cmd.usage();
  if (usage && usage !== "[options]") {
    parts.push("");
    parts.push(`**Usage:** \`ppm ${pathName} ${usage}\``);
  }

  parts.push("");

  // Recurse into subcommands (preserve registration order per phase 2 spec).
  const subs = cmd.commands.filter((c) => !isHidden(c));
  for (const sub of subs) {
    parts.push(renderCommand(sub, depth + 1));
  }

  return parts.join("\n");
}

function commandPath(cmd: Command): string {
  // Walk up parents to construct e.g. `db list` instead of just `list`.
  const chain: string[] = [];
  let cur: Command | null = cmd;
  while (cur && cur.parent) {
    chain.unshift(cur.name());
    cur = cur.parent;
  }
  return chain.join(" ");
}
