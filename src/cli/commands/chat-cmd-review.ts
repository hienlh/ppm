import type { Command } from "commander";
import type { SessionAnswerResult, SessionFileChange, SessionFileDiff } from "../../shared/session-file-changes.ts";
import { C, fail, projectRequest, resolveChatTarget, run, type ChatTarget } from "./chat-cmd-request.ts";
import { lineCounts, pickListed, projectPathOf, readFiles, reviewSub, shownPath } from "./chat-cmd-review-read.ts";

/**
 * `ppm chat changes …`: the files a chat changed, and the Review tab's answers — keep, reopen,
 * revert, undo — through the routes that tab calls. Each answer goes with the version of every file
 * just read, so a file that moved meanwhile is left alone and named as stale.
 */

export type Opts = { project?: string; json?: boolean; block?: string[]; limit?: string; yes?: boolean };

/** A command on one chat: `<verb> <session-id> …` with `-p`, the chat resolved before `act`. */
export function chatCommand(parent: Command, spec: string, description: string, act: (t: ChatTarget, opts: Opts, ...args: unknown[]) => Promise<void>): Command {
  return parent
    .command(spec)
    .description(description)
    .option("-p, --project <name>", "The chat's project (default: the one PPM recorded for it)")
    // Commander passes the arguments, then the options, then the command itself.
    .action((...all: unknown[]) => {
      const opts = all[all.length - 2] as Opts;
      const [id, ...args] = all.slice(0, -2);
      return run(async () => act(await resolveChatTarget(id as string, opts.project), opts, ...args))();
    });
}

function printList(files: SessionFileChange[], projectPath: string): void {
  if (files.length === 0) return console.log(`${C.dim}This chat changed no files PPM can see.${C.reset}`);
  for (const f of files) {
    const open = f.blocks ? `${f.blocks.filter((b) => !b.kept).length}/${f.blocks.length} open` : "whole file";
    const mark = f.reviewed ? ` ${C.green}reviewed${C.reset}` : "";
    console.log(`${lineCounts(f).padEnd(12)} ${open.padEnd(10)} ${shownPath(f.path, projectPath)}${mark}`);
  }
}

async function printDiff(diff: SessionFileDiff): Promise<void> {
  const { computeBlocks } = await import("../../shared/review-blocks.ts");
  const cut = diff.binary || diff.tooLarge ? null : computeBlocks(diff.original, diff.modified, { timeoutMs: 1000 });
  if (!cut) return console.log(`${C.dim}Binary, too large or too slow to diff; it can only be answered whole.${C.reset}`);
  const kept = new Set((diff.blocks ?? []).filter((b) => b.kept).map((b) => b.key));
  for (const b of cut.blocks) {
    console.log(`${C.cyan}@@ -${b.oldFrom + 1},${b.oldTo - b.oldFrom} +${b.newFrom + 1},${b.newTo - b.newFrom} @@ block ${b.key}${kept.has(b.key) ? " (kept)" : ""}${C.reset}`);
    for (const row of b.rows) console.log(`${row.k === "+" ? C.green : row.k === "-" ? C.red : ""}${row.k}${row.text}${C.reset}`);
  }
}

/** Every file of an answer, at the version just read; `--block` narrows the one file named. */
async function answerFiles(t: ChatTarget, paths: string[], opts: Opts, whenNone: (f: SessionFileChange) => boolean) {
  const files = await readFiles(t);
  const projectPath = await projectPathOf(t.project);
  if (opts.block?.length && paths.length !== 1) fail("--block names blocks of one file: give exactly one path with it");
  const picked = paths.length ? paths.map((p) => pickListed(files, projectPath, p)) : files.filter(whenNone);
  return {
    projectPath,
    files: [...new Set(picked)].map((f) => {
      if (!opts.block?.length) return { path: f.path, version: f.version };
      const known = new Set((f.blocks ?? []).map((b) => b.key));
      const unknown = opts.block.find((k) => !known.has(k));
      if (unknown) fail(`${shownPath(f.path, projectPath)} has no block ${unknown}; see \`ppm chat changes diff\``);
      return { path: f.path, version: f.version, keys: opts.block };
    }),
  };
}

export function printAnswer(r: SessionAnswerResult, projectPath: string, verb: string, t: ChatTarget): void {
  for (const f of r.files) {
    const path = shownPath(f.path, projectPath);
    if (f.stale) console.log(`${C.yellow}stale:${C.reset} ${path} changed since it was read; nothing was done to it`);
    else if (f.error) console.log(`${C.red}not ${verb}:${C.reset} ${path}: ${f.error}`);
    else console.log(`${C.green}${verb}:${C.reset} ${path}`);
  }
  if (r.undoId) console.log(`${C.dim}Undo: ppm chat changes undo ${t.id} ${r.undoId}${C.reset}`);
}

function answerCommand(changes: Command, verb: "keep" | "reopen" | "revert", description: string): void {
  const spec = verb === "revert" ? "revert <session-id> <paths...>" : `${verb} <session-id> [paths...]`;
  chatCommand(changes, spec, description, async (t, opts, paths) => {
    const whenNone = verb === "keep" ? (f: SessionFileChange) => !f.reviewed : (f: SessionFileChange) => !!f.reviewed || !!f.blocks?.some((b) => b.kept);
    const { files, projectPath } = await answerFiles(t, (paths as string[] | undefined) ?? [], opts, whenNone);
    if (files.length === 0) return console.log(`${C.dim}Nothing to ${verb}.${C.reset}`);
    const answer = verb === "reopen" ? "open" : verb;
    const r = await projectRequest<SessionAnswerResult>("POST", t.project, reviewSub(t, "/answer"), { answer, files });
    printAnswer(r, projectPath, { keep: "kept", reopen: "reopened", revert: "reverted" }[verb], t);
  }).option("--block <keys...>", "Only these blocks of the one file named (keys from `ppm chat changes diff`)");
}

export function registerChatReviewCommands(chat: Command): void {
  const changes = chat.command("changes").description("Review the files a chat changed, as its Review tab does");

  chatCommand(changes, "list <session-id>", "List the files a chat changed: lines, open blocks, reviewed", async (t, opts) => {
    const files = await readFiles(t);
    if (opts.json) return console.log(JSON.stringify({ files }, null, 2));
    printList(files, await projectPathOf(t.project));
  }).option("--json", "Print the list as JSON");

  chatCommand(changes, "diff <session-id> <path>", "Show one changed file's blocks (with their keys) as a diff", async (t, _opts, path) => {
    const projectPath = await projectPathOf(t.project);
    const file = pickListed(await readFiles(t), projectPath, path as string);
    await printDiff(await projectRequest<SessionFileDiff>("GET", t.project, `${reviewSub(t, "/diff")}?path=${encodeURIComponent(file.path)}`));
  });

  answerCommand(changes, "keep", "Keep a chat's changes (every unreviewed file when no path is given)");
  answerCommand(changes, "reopen", "Open kept changes for review again (every kept or reviewed file when no path is given)");
  answerCommand(changes, "revert", "Put files back as they were before the chat changed them; undo is offered afterwards");

  chatCommand(changes, "undo <session-id> <undo-id>", "Undo an earlier keep, reopen or revert by the id it printed", async (t, _opts, undoId) => {
    const r = await projectRequest<SessionAnswerResult>("POST", t.project, reviewSub(t, "/undo"), { undoId });
    if (r.stale) fail("Not undone: a file changed since that answer; nothing was put back");
    console.log(`${C.green}Undone:${C.reset} ${r.files.length} file(s)`);
  });
}
