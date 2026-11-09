/**
 * `ppm schedule export|import|state|set-state`: schedules as shareable files, and a script's
 * state. All of it goes through the running server. Nothing here prints a secret's value, not
 * even in an error: a `--secret` pair is never echoed back.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import { coerceInputValue, missingRequiredInputs } from "../../shared/schedule-inputs.ts";
import { parseScheduleTemplate, serializeScheduleTemplate, type ScheduleTemplate } from "../../shared/schedule-template.ts";
import type { ScheduleInputValue, ScheduleView } from "../../types/scheduler.ts";
import { api, C, fail } from "./schedule-cmd-api.ts";

const collect = (value: string, previous: string[]) => [...previous, value];

export interface ImportOptions {
  project: string;
  set: string[];
  secret: string[];
  trust?: boolean;
}

/** The body of POST /api/schedules/import for `file`; throws on anything it cannot use. */
export function importBody(file: string, opts: ImportOptions) {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`Cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  const parsed = parseScheduleTemplate(text);
  if (!parsed.ok) throw new Error(`${file} is not a template PPM can import:\n  ${parsed.errors.join("\n  ")}`);
  const decls = new Map((parsed.template.inputs ?? []).map((d) => [d.key, d]));
  const inputValues: Record<string, ScheduleInputValue> = {};
  for (const pair of opts.set) {
    const [key, raw] = splitPair(pair, "--set");
    const decl = decls.get(key);
    if (!decl) throw new Error(`The template has no input named "${key}"`);
    if (decl.type === "secret") throw new Error(`"${key}" is a secret; pass it with --secret`);
    const value = coerceInputValue(decl, raw);
    if (value instanceof Error) throw value;
    inputValues[key] = value;
  }
  const secrets: Record<string, string> = {};
  for (const pair of opts.secret) {
    const [key, raw] = splitPair(pair, "--secret");
    if (decls.get(key)?.type !== "secret") throw new Error(`The template has no secret input named "${key}"`);
    secrets[key] = raw.startsWith("@") ? readSecretFile(raw.slice(1), key) : raw;
  }
  return { template: parsed.template, projectName: opts.project, inputValues, secrets, trust: opts.trust === true };
}

/** `key=value`. The pair is not quoted in the error: it may be a secret. */
function splitPair(pair: string, flag: string): [string, string] {
  const eq = pair.indexOf("=");
  if (eq <= 0) throw new Error(`${flag} takes key=value`);
  return [pair.slice(0, eq), pair.slice(eq + 1)];
}

/** A secret kept in a file, so it never sits in the shell's history; one trailing newline dropped. */
function readSecretFile(path: string, key: string): string {
  try {
    return readFileSync(path, "utf8").replace(/\r?\n$/, "");
  } catch (e) {
    throw new Error(`Cannot read the file for the secret "${key}": ${(e as NodeJS.ErrnoException).code ?? "unreadable"}`);
  }
}

export function registerScheduleTemplateCommands(schedule: Command, loadDeps: () => Promise<unknown>): void {
  schedule
    .command("export <id>")
    .description("Write a schedule as a shareable template — never its secrets, state or history")
    .option("-o, --output <file>", "Write to this file instead of standard output")
    .action(async (id: string, opts: { output?: string }) => {
      await loadDeps();
      const { template, warnings } = await api<{ template: ScheduleTemplate; warnings: string[] }>("GET", `/schedules/${id}/export`);
      const text = serializeScheduleTemplate(template);
      if (opts.output) {
        writeFileSync(opts.output, text);
        console.error(`${C.green}✓${C.reset} Wrote ${opts.output}`);
      } else {
        process.stdout.write(text);
      }
      console.error(`${C.dim}Non-secret input values were included as defaults. Secrets were left out.${C.reset}`);
      for (const warning of warnings) console.error(`${C.yellow}⚠${C.reset} ${warning}`);
    });

  schedule
    .command("import <file>")
    .description("Create a schedule from a template, turned off. Read its code before you trust it.")
    .requiredOption("--project <name>", "Project it runs in")
    .option("--set <key=value>", "Value of an input (repeatable)", collect, [])
    .option("--secret <key=value|key=@file>", "Value of a secret input; @file reads it from a file (repeatable)", collect, [])
    .option("--trust", "I have read this code and trust it to run on this machine")
    .action(async (file: string, opts: ImportOptions) => {
      await loadDeps();
      let body: ReturnType<typeof importBody>;
      try {
        body = importBody(file, opts);
      } catch (e) {
        return fail((e as Error).message);
      }
      if (!body.trust) fail(`Read the code in ${file} first, then pass --trust to say you trust it to run on this machine`);
      const created = await api<ScheduleView>("POST", "/schedules/import", body);
      console.log(`${C.green}✓${C.reset} Schedule ${C.bold}#${created.id}${C.reset} "${created.name}" imported, turned off`);
      const missing = missingRequiredInputs(created.inputs, created.inputValues, created.secretsSet);
      if (missing.length) console.log(`  Fill in ${missing.join(", ")} before turning it on`);
      else console.log(`  Turn it on with: ppm schedule enable ${created.id}`);
    });

  schedule
    .command("state <id>")
    .description("Print a script schedule's state, secrets masked")
    .action(async (id: string) => {
      await loadDeps();
      const { state } = await api<{ state: string | null }>("GET", `/schedules/${id}/state`);
      console.log(state ?? `${C.dim}No state.${C.reset}`);
    });

  schedule
    .command("set-state <id> <file>")
    .description("Replace a script schedule's state with a JSON file; the schedule must be off")
    .action(async (id: string, file: string) => {
      await loadDeps();
      let state: unknown;
      try {
        state = JSON.parse(readFileSync(file, "utf8"));
      } catch (e) {
        // Not the parser's message: it quotes the text it stopped at, which may be a token.
        return fail(`${file} ${(e as NodeJS.ErrnoException).code ? "cannot be read" : "is not valid JSON"}`);
      }
      await api("PUT", `/schedules/${id}/state`, { state });
      console.log(`${C.green}✓${C.reset} State of schedule #${id} replaced`);
    });
}
