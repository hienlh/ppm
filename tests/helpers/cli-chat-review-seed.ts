/**
 * Two turns of file changes for a chat session, recorded the way PPM's capture hooks record them —
 * each file's "before", and its state before and after every call — plus the history that names
 * those calls, for the review CLI tests. Runs inside the scratch server, under its `PPM_HOME`.
 *
 * Turn 1 (`toolu_1`) changes line 5 of `a.ts`; turn 2 changes line 30 of `a.ts` (`toolu_2`) and
 * `b.ts` (`toolu_3`).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordBaseline } from "../../src/services/session-file-baselines/session-file-baselines.service.ts";
import { observeFile } from "../../src/services/session-file-baselines/session-file-history.ts";
import type { ChatEvent, ChatMessage } from "../../src/types/chat.ts";

export const SEED_BASE = Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`).join("");
export const SEED_B = "alpha\nbeta\n";

export async function seedReview(sessionId: string, dir: string): Promise<{ messages: ChatMessage[]; files: { a: string; b: string } }> {
  mkdirSync(dir, { recursive: true });
  const a = join(dir, "a.ts");
  const b = join(dir, "b.ts");
  writeFileSync(a, SEED_BASE);
  writeFileSync(b, SEED_B);
  recordBaseline(sessionId, a, SEED_BASE);
  recordBaseline(sessionId, b, SEED_B);
  const call = async (file: string, id: string, next: string) => {
    await observeFile(sessionId, file, id, "before");
    writeFileSync(file, next);
    await observeFile(sessionId, file, id, "after");
  };
  const one = SEED_BASE.replace("line 5\n", "five\n");
  await call(a, "toolu_1", one);
  await call(a, "toolu_2", one.replace("line 30\n", "thirty\n"));
  await call(b, "toolu_3", "alpha\nBETA\n");

  const at = (minute: number) => `2026-11-13T05:0${minute}:00.000Z`;
  const edit = (id: string, file: string, from: string, to: string): ChatEvent =>
    ({ type: "tool_use", tool: "Edit", input: { file_path: file, old_string: from, new_string: to }, toolUseId: id });
  const messages: ChatMessage[] = [
    { id: "u1", role: "user", content: "change line five", timestamp: at(1), turnN: 1 },
    { id: "a1", role: "assistant", content: "", timestamp: at(2), events: [edit("toolu_1", a, "line 5", "five")] },
    { id: "u2", role: "user", content: "now line thirty and b", timestamp: at(3), turnN: 2 },
    { id: "a2", role: "assistant", content: "", timestamp: at(4), events: [edit("toolu_2", a, "line 30", "thirty"), edit("toolu_3", b, "beta", "BETA")] },
  ];
  return { messages, files: { a, b } };
}
