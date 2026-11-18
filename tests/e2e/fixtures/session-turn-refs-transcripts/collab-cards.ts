/**
 * Seeds alpha / G, a Claude chat whose answers carry two `send_to_session` tool cards: one to beta's
 * D (another project, as a manager or the Assistant messages a chat of another project) and one to
 * alpha's B (the same project). Their "Open session" buttons are what the open-other-project-chat
 * e2e clicks. Seeded only when that e2e asks for it, so the turn-reference e2e sees its own
 * sessions unchanged.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeTranscript } from "./claude-transcript";
import { claudeSlug, type SeededSession, type SeedPaths } from "./seed-sessions";

const T0 = Date.parse("2026-10-26T08:00:00.000Z");
export const COLLAB_CARDS_ID = "e7e7e7e7-7777-4777-8777-000000000007";

export function seedCollabCards(paths: SeedPaths, targets: { other: SeededSession; same: SeededSession }): SeededSession {
  const t = new ClaudeTranscript(COLLAB_CARDS_ID, paths.alpha, T0);
  const turnIds: string[] = [];
  const cards = [
    { target: targets.other, prompt: "Tell the billing chat the export is ready", id: "toolu_01SendToOtherProject0001" },
    { target: targets.same, prompt: "Ask the planning chat for the next step", id: "toolu_01SendToSameProject00001" },
  ];
  cards.forEach(({ target, prompt, id }, k) => {
    const promptId = `e7e7e7e7-0000-4000-8000-00000000000${k + 1}`;
    turnIds.push(promptId);
    const result = { sessionId: target.id, providerId: "claude", title: target.title, project: target.project, delivered: "inserted" };
    t.turn({
      promptId, prompt, minute: (k + 1) * 2,
      answer: `Sent to ${target.title}.`,
      tool: { id, name: "mcp__ppm-sessions__send_to_session", input: { session_id: target.id, message: prompt }, output: JSON.stringify(result) },
    });
  });
  const dir = join(paths.claudeProjects, claudeSlug(paths.alpha));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${COLLAB_CARDS_ID}.jsonl`), t.toString());
  return { id: COLLAB_CARDS_ID, title: "Messages out", project: "alpha", turnIds };
}
