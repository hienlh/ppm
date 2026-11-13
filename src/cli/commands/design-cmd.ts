import { resolve } from "node:path";
import type { Command } from "commander";
import type { DesignSnapshotInfo, DesignSummary, DesignSystemSummary } from "../../shared/design-types.ts";
import { C, currentProjectName, fail, run } from "./chat-cmd-request.ts";
import { apiDownload, apiRequest, projectApiPath, type ApiQuery } from "../utils/project-route.ts";
import { printTable } from "./cli-table.ts";

/**
 * `ppm design`: a project's designs, through the routes the Designs sidebar calls — through the
 * running PPM that holds the database, so every open PPM's design list refreshes on its
 * `design:list_changed`; with no PPM running, the same routes run here. A delete asks for
 * `--yes` and otherwise only says what would go. An export is saved with `Bun.write`.
 */

interface DesignOpts { project?: string; json?: boolean }

function designCommand(parent: Command, spec: string, description: string): Command {
  return parent
    .command(spec)
    .description(description)
    .option("-p, --project <name>", "Project name or path (default: the project the current folder is in)")
    .option("--json", "Print the route's answer as JSON");
}

async function designPath(opts: DesignOpts, sub = "", query: ApiQuery = {}): Promise<string> {
  return projectApiPath(await currentProjectName(opts.project), `designs${sub}`, query);
}

const slugPart = (slug: string) => `/${encodeURIComponent(slug)}`;

function report(opts: DesignOpts, data: unknown, line: string): void {
  console.log(opts.json ? JSON.stringify(data, null, 2) : line);
}

export function registerDesignCommands(program: Command): void {
  const design = program.command("design").description("A project's designs: list, create, rename, delete, history, restore, export");

  designCommand(design, "list", "List the project's designs, newest first")
    .action((opts: DesignOpts) => run(async () => {
      const data = await apiRequest<{ designs: DesignSummary[]; systems: DesignSystemSummary[] }>("GET", await designPath(opts));
      if (opts.json) return void console.log(JSON.stringify(data, null, 2));
      if (!data.designs.length) return void console.log(`${C.dim}No designs yet.${C.reset}`);
      printTable(["Slug", "Title", "Kind", "App", "Updated"], data.designs.map((d) => [d.slug, d.title, d.kind, d.system, d.updatedAt]));
    })());

  designCommand(design, "create <title>", "Create an empty design (the AI fills it from a design chat)")
    .option("--kind <kind>", "page or slides", "page")
    .option("--system <id>", "The app it belongs to (default: the project's default app)")
    .action((title: string, opts: DesignOpts & { kind: string; system?: string }) => run(async () => {
      const made = await apiRequest<DesignSummary>("POST", await designPath(opts), { title, kind: opts.kind, ...(opts.system && { system: opts.system }) });
      report(opts, made, `${C.green}✓${C.reset} Design ${made.slug} created (designs/${made.slug}/${made.entry})`);
    })());

  designCommand(design, "rename <slug> <title>", "Change a design's title (its folder keeps its slug)")
    .action((slug: string, title: string, opts: DesignOpts) => run(async () => {
      const renamed = await apiRequest<DesignSummary>("PATCH", await designPath(opts, slugPart(slug)), { title });
      report(opts, renamed, `${C.green}✓${C.reset} Design ${slug} is now "${renamed.title}"`);
    })());

  designCommand(design, "delete <slug>", "Delete a design's folder and its history; without --yes, only says what would go")
    .option("-y, --yes", "Delete it")
    .action((slug: string, opts: DesignOpts & { yes?: boolean }) => run(async () => {
      if (!opts.yes) {
        const [found, history] = await Promise.all([
          apiRequest<DesignSummary>("GET", await designPath(opts, slugPart(slug))),
          apiRequest<DesignSnapshotInfo[]>("GET", await designPath(opts, `${slugPart(slug)}/history`)),
        ]);
        console.log(`Would delete design ${found.slug} "${found.title}": the folder designs/${found.slug}/ and ${history.length} history snapshot${history.length === 1 ? "" : "s"}.`);
        console.log(`${C.dim}Nothing was deleted. Run again with --yes to delete it.${C.reset}`);
        return;
      }
      const done = await apiRequest<{ deleted: string }>("DELETE", await designPath(opts, slugPart(slug), { confirm: slug }));
      report(opts, done, `${C.green}✓${C.reset} Design ${done.deleted} deleted`);
    })());

  designCommand(design, "history <slug>", "List a design's snapshots, newest first")
    .action((slug: string, opts: DesignOpts) => run(async () => {
      const snapshots = await apiRequest<DesignSnapshotInfo[]>("GET", await designPath(opts, `${slugPart(slug)}/history`));
      if (opts.json) return void console.log(JSON.stringify(snapshots, null, 2));
      if (!snapshots.length) return void console.log(`${C.dim}No snapshots yet.${C.reset}`);
      printTable(["Snapshot", "Reason", "Taken", "Files"], snapshots.map((s) => [s.id, s.reason, s.createdAt, String(s.fileCount)]));
    })());

  designCommand(design, "restore <slug> <snapshotId>", "Put a design back to a snapshot (the current state is kept as a snapshot first)")
    .action((slug: string, id: string, opts: DesignOpts) => run(async () => {
      const done = await apiRequest<unknown>("POST", await designPath(opts, `${slugPart(slug)}/history/${encodeURIComponent(id)}/restore`));
      report(opts, done, `${C.green}✓${C.reset} Design ${slug} restored to ${id}`);
    })());

  designCommand(design, "export <slug>", "Save a design as a zip of its folder, or as one self-contained HTML file")
    .option("--zip", "The design's folder as a zip")
    .option("--html", "One self-contained HTML file of its entry page")
    .requiredOption("-o, --output <file>", "Where to save it")
    .action((slug: string, opts: DesignOpts & { zip?: boolean; html?: boolean; output: string }) => run(async () => {
      if (!!opts.zip === !!opts.html) fail("Pass one of --zip or --html");
      const res = await apiDownload(await designPath(opts, `${slugPart(slug)}/export/${opts.zip ? "zip" : "html"}`), { timeoutMs: 120_000 });
      const file = resolve(opts.output);
      const bytes = await Bun.write(file, res);
      const warnings = Number(res.headers.get("X-PPM-Export-Warnings") ?? 0);
      report(opts, { file, bytes, warnings }, `${C.green}✓${C.reset} Saved ${file} (${bytes} bytes)`
        + (warnings ? `\n${C.yellow}!${C.reset} ${warnings} asset${warnings === 1 ? "" : "s"} could not be inlined` : ""));
    })());
}
