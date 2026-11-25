import type { Command } from "commander";
import { C, run } from "./chat-cmd-request.ts";
import { ppmApiRequest } from "../utils/settings-request.ts";
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project.ts";
import type { BlockedWord, LearnedWord, LearningPair } from "../../shared/voice-message.ts";

/**
 * `ppm speech learned`: the words voice messages taught PPM, per project, through the route
 * Settings → Voice → Self-learning calls — so the running PPM changes them and every open pane
 * refreshes. `remove` is the pane's Undo for a learned word and its "Don't learn" for a pair still
 * being counted; `restore` is its Restore. Nothing is learned from here: a word to listen for is
 * a project or global word (Settings → Voice), not a learned one.
 */

/** The part of `GET /speech/voice-settings` these commands read. */
interface VoiceListsView {
  projectLearned: LearnedWord[];
  projectLearning: LearningPair[];
  projectBlocked: BlockedWord[];
}

const PROJECT_HELP = `Which project's lists (default: the PPM Assistant, "${ASSISTANT_PROJECT_NAME}")`;
const projectOf = (opts: { project?: string }) => opts.project?.trim() || ASSISTANT_PROJECT_NAME;
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const pair = (from: string, to: string) => `${from} → ${to}`;

async function readLists(project: string): Promise<VoiceListsView> {
  return ppmApiRequest<VoiceListsView>("GET", `/speech/voice-settings?project=${encodeURIComponent(project)}`);
}

/** What `remove` acts on: a learned word, or a pair still being counted, named by its meant word. */
export function findRemovable(view: VoiceListsView, word: string): { kind: "learned" | "learning"; word: string; items: string[] } | null {
  const learned = view.projectLearned.filter((l) => same(l.word, word));
  if (learned.length) return { kind: "learned", word: learned[0]!.word, items: learned.map((l) => pair(l.from, l.word)) };
  const learning = view.projectLearning.filter((c) => same(c.to, word));
  if (learning.length) return { kind: "learning", word: learning[0]!.to, items: learning.map((c) => pair(c.from, c.to)) };
  return null;
}

function printLists(project: string, view: VoiceListsView): void {
  console.log(`${C.cyan}Learned${C.reset} (${project})`);
  if (!view.projectLearned.length) console.log(`  ${C.dim}(none)${C.reset}`);
  for (const l of view.projectLearned) console.log(`  ${pair(l.from, l.word)}  ${C.dim}${l.source ?? "edit"} · ${l.hits ?? 1}× · ${l.at.slice(0, 10)}${C.reset}`);
  console.log(`${C.cyan}Being learned${C.reset}`);
  if (!view.projectLearning.length) console.log(`  ${C.dim}(none)${C.reset}`);
  for (const c of view.projectLearning) {
    const progress = c.source === "chat" ? `${c.chats} of 3 chats or days` : `seen ${c.hits}×`;
    console.log(`  ${pair(c.from, c.to)}  ${C.dim}${c.source} · ${progress} · ${c.at.slice(0, 10)}${C.reset}`);
  }
  if (view.projectBlocked.length) {
    console.log(`${C.cyan}Undone${C.reset} ${C.dim}(never learned again until restored)${C.reset}`);
    for (const b of view.projectBlocked) console.log(`  ${pair(b.from, b.word)}${b.learning?.length ? `  ${C.dim}stopped while being learned${C.reset}` : ""}`);
  }
}

export function registerSpeechLearnedCommands(speech: Command): void {
  const learned = speech.command("learned").description("Words voice messages taught PPM: list them, undo one, or restore one");

  learned
    .command("list")
    .description("List a project's learned words, the pairs still being learned, and the undone ones")
    .option("--project <name>", PROJECT_HELP)
    .option("--json", "Print JSON")
    .action((opts: { project?: string; json?: boolean }) => run(async () => {
      const project = projectOf(opts);
      const view = await readLists(project);
      if (opts.json) {
        console.log(JSON.stringify({ project, learned: view.projectLearned, learning: view.projectLearning, undone: view.projectBlocked }, null, 2));
      } else printLists(project, view);
    })());

  learned
    .command("remove <word>")
    .description("Undo a learned word, or stop learning a pair (by the word it means); it is not learned again until restored")
    .option("--project <name>", PROJECT_HELP)
    .action((word: string, opts: { project?: string }) => run(async () => {
      const project = projectOf(opts);
      const found = findRemovable(await readLists(project), word);
      if (!found) throw new Error(`"${word}" is neither learned nor being learned in ${project}. See \`ppm speech learned list --project ${project}\`.`);
      await ppmApiRequest("PUT", "/speech/voice-settings", {
        project, ...(found.kind === "learned" ? { removeLearned: [found.word] } : { skipLearning: [found.word] }),
      });
      const what = found.kind === "learned" ? "Undid" : "Stopped learning";
      console.log(`${C.green}✓${C.reset} ${what} ${found.items.join(", ")} in ${project}. Put it back with \`ppm speech learned restore "${found.word}" --project ${project}\`.`);
    })());

  learned
    .command("restore <word>")
    .description("Bring back an undone word: learned again, or counted again where it left off")
    .option("--project <name>", PROJECT_HELP)
    .action((word: string, opts: { project?: string }) => run(async () => {
      const project = projectOf(opts);
      const blocked = (await readLists(project)).projectBlocked.filter((b) => same(b.word, word));
      if (!blocked.length) throw new Error(`"${word}" is not in ${project}'s undone list.`);
      await ppmApiRequest("PUT", "/speech/voice-settings", { project, restoreBlocked: [blocked[0]!.word] });
      console.log(`${C.green}✓${C.reset} Restored ${blocked.map((b) => pair(b.from, b.word)).join(", ")} in ${project}.`);
    })());
}
