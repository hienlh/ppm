import {
  type Group,
  type GroupMember,
  type GroupMessage,
  type TurnEngineDeps,
  type TurnLoopResult,
  type TerminationReason,
} from "../../types/group-chat.ts";
import { buildContextWindow, renderWindow, DEFAULT_WINDOW } from "./context-window.ts";

const DONE_RE = /^\s*DONE:/i;
const MENTION_RE = /@(\w+)/;

function findMember(members: GroupMember[], name: string): GroupMember | undefined {
  return members.find((m) => m.name === name);
}

function leaderOf(members: GroupMember[]): GroupMember {
  return members.find((m) => m.role === "leader") ?? members[0];
}

/** Pick the next speaker from an @mention in `text`; else fall back:
 *  leader → first non-leader member; member → leader (keeps discussion moving). */
export function selectNextSpeaker(text: string, current: string, members: GroupMember[]): string {
  const m = text.toLowerCase().match(MENTION_RE);
  if (m) {
    const target = m[1];
    if (target !== current && findMember(members, target)) return target;
  }
  const leader = leaderOf(members);
  if (current === leader.name) {
    const other = members.find((x) => x.role !== "leader");
    return other?.name ?? leader.name;
  }
  return leader.name;
}

/** Build the per-turn prompt for `speaker`: task + windowed channel + rolling
 *  summary + role instructions. Only the leader may finalize with "DONE:". */
export function buildTurnContext(
  group: Group,
  speaker: GroupMember,
  members: GroupMember[],
  task: string,
  deps: TurnEngineDeps,
  opts: { window?: number; forceFinal?: boolean } = {},
): string {
  const window = opts.window ?? DEFAULT_WINDOW;
  const prior = deps.readMessages(group.id);
  const { window: recent, rollingSummary } = buildContextWindow(prior, window);
  const others = members.filter((m) => m.name !== speaker.name).map((m) => m.name).join(", ");
  const isLeader = speaker.role === "leader";
  const persona = speaker.persona ? `, ${speaker.persona}` : "";

  const parts = [
    `You are "${speaker.name}"${persona}.`,
    `Team task: ${task}`,
    rollingSummary ? `\nEARLIER (summary):\n${rollingSummary}` : "",
    `\nTEAM CHANNEL (recent, teammates: ${others}):\n${renderWindow(recent)}`,
    `\nReply in MAX 2 sentences. Address a teammate with @name (e.g. @${others.split(", ")[0] || "alice"}).`,
    isLeader
      ? (opts.forceFinal
          ? `You MUST finalize now: start your message with "DONE:" then the decision + 1 reason.`
          : `If the team has converged, start with "DONE:" then the decision + 1 reason. Otherwise steer the discussion and @ someone.`)
      : `Do NOT write "DONE:" — only the leader finalizes.`,
  ];
  return parts.filter(Boolean).join("\n");
}

/** Run the shared-channel turn loop until one of four termination conditions:
 *  leader DONE · max_turns · budget cap · external stop. Always emits exactly
 *  one `final` message and always terminates (cap guarantees). */
export async function runGroupTurnLoop(
  group: Group,
  members: GroupMember[],
  deps: TurnEngineDeps,
  task: string,
): Promise<TurnLoopResult> {
  const leader = leaderOf(members);
  let speaker = leader.name;
  let turns = 0;
  let costUsd = 0;
  let reason: TerminationReason | null = null;
  let finalText = "";

  for (let turnIndex = 0; turnIndex < group.maxTurns; turnIndex++) {
    if (deps.shouldStop?.()) { reason = "stopped"; break; }

    const member = findMember(members, speaker) ?? leader;
    const isLastTurn = turnIndex === group.maxTurns - 1;
    // Force the leader to finalize on the final allowed turn.
    const forceFinal = isLastTurn && member.role === "leader";
    const prompt = buildTurnContext(group, member, members, task, deps, { forceFinal });

    const result = await deps.runAgent(member, prompt);
    turns++;
    costUsd += result.usage?.costUsd ?? 0;
    const text = result.text ?? "";

    const isDone = member.role === "leader" && DONE_RE.test(text);
    const mention = text.match(MENTION_RE)?.[1] ?? null;

    const msg = deps.appendMessage({
      groupId: group.id,
      fromMember: member.name,
      toMember: isDone ? "all" : mention,
      kind: isDone ? "final" : "chat",
      summary: text,
      fullSessionRef: member.sessionId,
      turnIndex,
    });
    deps.onMessage?.(msg);

    if (isDone) { reason = "leader_done"; return { reason, turns, costUsd }; }

    if (costUsd >= group.maxCostUsd) { reason = "budget"; finalText = text; break; }

    // If the next turn is the last, steer to the leader so it can finalize.
    if (turnIndex >= group.maxTurns - 2) {
      speaker = leader.name;
    } else {
      speaker = selectNextSpeaker(text, speaker, members);
    }
  }

  if (reason === null) reason = "max_turns";

  // Ensure exactly one `final` message when the loop ended without a leader DONE.
  const finalMsg = deps.appendMessage({
    groupId: group.id,
    fromMember: leader.name,
    toMember: "all",
    kind: "final",
    summary: buildFinalSummary(reason, finalText),
    fullSessionRef: leader.sessionId,
    turnIndex: turns,
  });
  deps.onMessage?.(finalMsg);

  return { reason, turns, costUsd };
}

function buildFinalSummary(reason: TerminationReason, lastText: string): string {
  switch (reason) {
    case "max_turns":
      return `DONE: discussion reached the turn cap. ${lastText}`.trim();
    case "budget":
      return `DONE: discussion reached the budget cap. ${lastText}`.trim();
    case "stopped":
      return `DONE: discussion stopped by request.`;
    default:
      return `DONE: ${lastText}`.trim();
  }
}
