import {
  type Group,
  type GroupMember,
  type BurstResult,
  type BurstEndReason,
  type TurnEngineDeps,
} from "../../types/group-chat.ts";
import { buildContextWindow, renderFull, DEFAULT_WINDOW } from "./context-window.ts";
import { dispatchParallel } from "./agent-runner.ts";

/** Max AI turns triggered by a single user message before yielding back to the user.
 *  Headroom for delegate → members report → leader wrap-up; the router ends earlier
 *  (returns none) when there's nothing left to add. */
export const REPLY_BURST_CAP = 10;

/** Matches @name mentions; unicode-aware so non-ASCII member names (e.g. "Bình") work. */
const MENTION_RE = /@([\p{L}\p{N}_]+)/u;
const MENTION_RE_G = /@([\p{L}\p{N}_]+)/gu;
/** Feed summary cap — the bus stores a short summary; full text lives in the member session. */
const SUMMARY_CAP = 600;

/** Cap a turn's text for the feed: first paragraph, bounded to SUMMARY_CAP. */
function feedSummary(text: string): string {
  const firstPara = text.split(/\n{2,}/)[0]?.trim() ?? text.trim();
  const base = firstPara.length > 0 ? firstPara : text.trim();
  return base.length > SUMMARY_CAP ? base.slice(0, SUMMARY_CAP).trimEnd() + "…" : base;
}

function findMember(members: GroupMember[], name: string): GroupMember | undefined {
  return members.find((m) => m.name === name);
}

function leaderOf(members: GroupMember[]): GroupMember {
  const leader = members.find((m) => m.role === "leader") ?? members[0];
  if (!leader) throw new Error("group has no members");
  return leader;
}

/** Explicit @mentions of known members in the user's message (in order, deduped). */
export function parseMentions(userText: string, members: GroupMember[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of userText.matchAll(MENTION_RE_G)) {
    const name = m[1]!;
    if (!seen.has(name) && findMember(members, name)) { out.push(name); seen.add(name); }
  }
  return out;
}

/** Who replies to a user message (legacy mention-following mode): each @mentioned member;
 *  if none mentioned, the leader answers. */
export function selectInitialResponders(userText: string, members: GroupMember[]): string[] {
  const mentions = parseMentions(userText, members);
  return mentions.length > 0 ? mentions : [leaderOf(members).name];
}

/** Next teammate to pull in from a reply's @mention, or null when the reply has no
 *  valid teammate mention (i.e. it was addressed to the user → end the burst). */
export function selectNextSpeaker(text: string, current: string, members: GroupMember[]): string | null {
  const target = text.match(MENTION_RE)?.[1];
  if (target && target !== current && findMember(members, target)) return target;
  return null;
}

/** Build the per-turn prompt for `speaker`. Keep-alive sessions retain the member's own
 *  past turns natively, so inject only the shared-channel DELTA since it last spoke (full
 *  text). First turn ever → the recent window (+ rolling summary) as a cold start. No
 *  task/DONE language; the member must not hand off (a coordinator picks the next speaker). */
export function buildTurnContext(
  group: Group,
  speaker: GroupMember,
  members: GroupMember[],
  deps: TurnEngineDeps,
  opts: { window?: number } = {},
): string {
  const window = opts.window ?? DEFAULT_WINDOW;
  const prior = deps.readMessages(group.id);
  const others = members.filter((m) => m.name !== speaker.name).map((m) => m.name).join(", ");
  const persona = speaker.persona ? `, ${speaker.persona}` : "";

  // Last turn index this member itself produced (native memory covers ≤ this).
  const lastSeen = prior.reduce(
    (mx, m) => (m.fromMember === speaker.name && m.turnIndex > mx ? m.turnIndex : mx),
    -1,
  );

  let contextBlock: string;
  if (lastSeen >= 0) {
    const delta = prior.filter((m) => m.turnIndex > lastSeen);
    contextBlock = `\nNEW SINCE YOU LAST SPOKE:\n${delta.length ? renderFull(delta) : "(nothing new)"}`;
  } else {
    const { window: recent, rollingSummary } = buildContextWindow(prior, window);
    contextBlock =
      (rollingSummary ? `\nEARLIER (summary):\n${rollingSummary}` : "") +
      `\nGROUP CHAT (recent):\n${renderFull(recent)}`;
  }

  const parts = [
    `You are "${speaker.name}"${persona}. You're chatting in a group with the user and your teammates: ${others}.`,
    contextBlock,
    `\nReply directly to the user, as yourself, in MAX 2 sentences — like a person in a group chat.`,
    `Just give YOUR answer. Do NOT @mention teammates or hand off turns ("@X your turn", "over to you") — a coordinator decides who speaks next; handing off only creates loops.`,
    `Do not narrate actions and never write "DONE".`,
  ];
  return parts.filter(Boolean).join("\n");
}

/** Run a bounded reply burst for the latest user message. When `deps.routeNextSpeaker`
 *  is provided, an LLM router picks the next speaker each turn (history-driven, allows
 *  AI↔AI silence, leader as fallback/moderator); otherwise it falls back to mention-
 *  following. Either way: user @mention is an absolute override, a user message always
 *  gets ≥1 reply, and total AI turns are capped. Emits only `kind:"chat"` messages. */
export async function runReplyBurst(
  group: Group,
  members: GroupMember[],
  deps: TurnEngineDeps,
  opts: { cap?: number; window?: number } = {},
): Promise<BurstResult> {
  return deps.routeNextSpeakers
    ? runRoutedBurst(group, members, deps, opts)
    : runMentionBurst(group, members, deps, opts);
}

/** Shared per-turn side effects: run the agent, persist + emit the message. */
async function runTurn(
  group: Group, members: GroupMember[], deps: TurnEngineDeps,
  name: string, turnIndex: number, window?: number,
): Promise<{ text: string; costUsd: number }> {
  const member = findMember(members, name) ?? leaderOf(members);
  const prompt = buildTurnContext(group, member, members, deps, { window });
  deps.onTyping?.(name);
  const result = await deps.runAgent(member, prompt);
  const text = result.text ?? "";
  const pull = selectNextSpeaker(text, name, members);
  const msg = deps.appendMessage({
    groupId: group.id,
    fromMember: name,
    toMember: pull,
    kind: "chat",
    summary: feedSummary(text),
    // Full text for cross-member context injection (feed UI still shows `summary`).
    data: { full: text },
    fullSessionRef: member.sessionId,
    turnIndex,
  });
  deps.onMessage?.(msg);
  return { text, costUsd: result.usage?.costUsd ?? 0 };
}

/** Dedupe names, keeping order, dropping unknown members. */
function knownUnique(names: string[], members: GroupMember[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    if (!seen.has(n) && findMember(members, n)) { out.push(n); seen.add(n); }
  }
  return out;
}

/** Router-driven turn-taking with PARALLEL batches: `deps.routeNextSpeakers` returns 0-N
 *  members to run concurrently this turn. User @mentions run first (absolute, in parallel);
 *  the first user-reply turn is forced to ≥1 (leader fallback); AI↔AI turns may end (empty →
 *  silence). Each batch member counts toward the cap; batches are bounded to the remaining cap. */
async function runRoutedBurst(
  group: Group, members: GroupMember[], deps: TurnEngineDeps,
  opts: { cap?: number; window?: number },
): Promise<BurstResult> {
  const cap = opts.cap ?? REPLY_BURST_CAP;
  const prior = deps.readMessages(group.id);
  const lastUser = [...prior].reverse().find((m) => m.fromMember === "user");
  let mentionQueue = parseMentions(lastUser?.summary ?? "", members);
  let nextTurnIndex = (prior[prior.length - 1]?.turnIndex ?? -1) + 1;

  let turns = 0;
  let assistantTurns = 0;
  let costUsd = 0;
  let reason: BurstEndReason = "no_more_mentions";

  while (true) {
    if (deps.shouldStop?.()) { reason = "stopped"; break; }
    if (turns >= cap) { reason = "cap_reached"; break; }

    const isUserTurn = assistantTurns === 0;
    let names: string[];
    if (mentionQueue.length > 0) {
      // Explicit user @mentions → all of them reply in parallel (absolute override).
      names = mentionQueue;
      mentionQueue = [];
    } else {
      const history = deps.readMessages(group.id);
      names = knownUnique(await deps.routeNextSpeakers!({ history, members, isUserTurn }), members);
      if (names.length === 0) {
        if (isUserTurn) names = [leaderOf(members).name]; // a user message always gets ≥1 reply
        else break; // AI↔AI: nothing more to add → silence
      }
    }

    // Bound the parallel batch to the remaining cap.
    names = names.slice(0, cap - turns);
    // Pre-assign turn indices so concurrent appends stay ordered/collision-free.
    const batch = names.map((name) => ({ name, turnIndex: nextTurnIndex++ }));
    const results = await dispatchParallel(
      batch.map((b) => () => runTurn(group, members, deps, b.name, b.turnIndex, opts.window)),
      cap, // concurrency ≤ cap (≤ remaining) — bounded fan-out, rate-limit guard
    );
    turns += batch.length;
    assistantTurns += batch.length;
    for (const r of results) costUsd += r.costUsd;
  }

  return { reason, turns, costUsd };
}

/** Legacy conversational mode (no router): mentions → those members, else the leader;
 *  repliers may @pull teammates; stop when a reply addresses the user (no mention). */
async function runMentionBurst(
  group: Group, members: GroupMember[], deps: TurnEngineDeps,
  opts: { cap?: number; window?: number },
): Promise<BurstResult> {
  const cap = opts.cap ?? REPLY_BURST_CAP;
  const prior = deps.readMessages(group.id);
  const lastUser = [...prior].reverse().find((m) => m.fromMember === "user");
  const queue = selectInitialResponders(lastUser?.summary ?? "", members);
  let nextTurnIndex = (prior[prior.length - 1]?.turnIndex ?? -1) + 1;
  let turns = 0;
  let costUsd = 0;
  let reason: BurstEndReason = "no_more_mentions";

  while (queue.length > 0) {
    if (deps.shouldStop?.()) { reason = "stopped"; break; }
    if (turns >= cap) { reason = "cap_reached"; break; }

    const name = queue.shift()!;
    const { text, costUsd: c } = await runTurn(group, members, deps, name, nextTurnIndex++, opts.window);
    turns++;
    costUsd += c;
    const pull = selectNextSpeaker(text, name, members);
    if (pull) queue.push(pull);
  }

  return { reason, turns, costUsd };
}
