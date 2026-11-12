import type { Command } from "commander";
import type { TurnRevertResult } from "../../shared/session-file-changes.ts";
import { C, fail, projectRequest } from "./chat-cmd-request.ts";
import { chatCommand } from "./chat-cmd-review.ts";
import { projectPathOf, readTurns, reviewSub, shownPath } from "./chat-cmd-review-read.ts";

/**
 * `ppm chat turns` and `ppm chat revert-turn`: a chat's turns by the numbers its chat shows, and
 * putting back what one of them changed. The revert is previewed first and written only with
 * `--yes`, at the versions that preview was worked out against — a file touched in between makes
 * PPM write nothing at all.
 */

export function registerChatTurnCommands(chat: Command): void {
  chatCommand(chat, "turns <session-id>", "List a chat's newest turns with their numbers and how many calls each made", async (t, opts) => {
    const r = await readTurns(t, opts.limit ? Number(opts.limit) : undefined);
    if (opts.json) return console.log(JSON.stringify(r, null, 2));
    if (r.turns.length === 0) return console.log(`${C.dim}This chat has no turns yet.${C.reset}`);
    for (const turn of r.turns) {
      const n = turn.unnumbered ? "?" : String(turn.n);
      console.log(`${C.cyan}${n.padStart(4)}${C.reset}  ${turn.at}  ${String(turn.calls.length).padStart(3)} calls  ${turn.prompt.split("\n")[0]}`);
    }
    if (r.total > r.turns.length) console.log(`${C.dim}${r.total - r.turns.length} older turns are not listed.${C.reset}`);
  }).option("--json", "Print the turns as JSON").option("--limit <n>", "How many of the newest turns (at most 50)", "20");

  chatCommand(chat, "revert-turn <session-id> <n>", "Put back what one turn changed: prints the preview, and writes only with --yes", async (t, opts, raw) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) fail("<n> must be a turn's number, as `ppm chat turns` prints it");
    // Loaded on use, so registering the command tree reads nothing past the CLI's own files.
    const { findTurn } = await import("../../services/session-file-baselines/session-turn-calls.ts");
    const { describeTurnRevertFile } = await import("../../services/assistant-mcp/assistant-approval-summary-review.ts");
    const turn = findTurn(await readTurns(t), n);
    if (typeof turn === "string") fail(turn);
    if (turn.calls.length === 0) fail(`Turn ${n} made no tool calls; there is nothing of it to put back`);

    const projectPath = await projectPathOf(t.project);
    const preview = await projectRequest<TurnRevertResult>("POST", t.project, reviewSub(t, "/revert-turn"), { calls: turn.calls });
    console.log(`Turn ${n} (${turn.at}): ${turn.prompt.split("\n")[0]}`);
    for (const f of preview.files) console.log(`  ${shownPath(f.path, projectPath)}: ${describeTurnRevertFile(f)}`);
    if (!preview.files.some((f) => f.action !== "none" && !f.error)) return console.log(`${C.dim}Nothing of this turn can be put back.${C.reset}`);
    if (!opts.yes) return console.log(`${C.yellow}Nothing was written.${C.reset} Run again with --yes to put these back.`);

    const applied = await projectRequest<TurnRevertResult>("POST", t.project, reviewSub(t, "/revert-turn"), {
      calls: turn.calls, apply: preview.files.map((f) => ({ path: f.path, version: f.version })),
    });
    if (applied.stale) fail("Not reverted: a file changed since the preview; nothing was written");
    console.log(`${C.green}Reverted turn ${n}.${C.reset}`);
    if (applied.undoId) console.log(`${C.dim}Undo: ppm chat changes undo ${t.id} ${applied.undoId}${C.reset}`);
  }).option("--yes", "Write the changes the preview shows");
}
