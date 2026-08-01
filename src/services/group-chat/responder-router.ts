import type { GroupMember, GroupMessage } from "../../types/group-chat.ts";
import { buildContextWindow, renderWindow, DEFAULT_WINDOW } from "./context-window.ts";

/** Cheapest/fastest model for the lightweight next-speaker classification. */
export const ROUTER_MODEL = "claude-haiku-4-5";
const NONE = "NONE";

/** Minimal backend the router needs (structural subset of agent-runner's ChatBackend). */
export interface RouterBackend {
  sendMessage(
    providerId: string,
    sessionId: string,
    prompt: string,
    opts?: { model?: string; permissionMode?: string; oneMContext?: boolean },
  ): AsyncIterable<{ type: string; content?: string; message?: string }>;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parse the router's reply into known member names (0-N), in order of appearance.
 *  Never invents a name — only exact member-name matches (case-insensitive, word-bounded).
 *  Longest names first + claimed spans so a short name can't match inside a longer one.
 *  NONE / unknown / garbage → []. */
export function parseResponders(text: string, members: GroupMember[]): string[] {
  const t = (text ?? "").trim();
  if (!t) return [];
  const byLen = [...members].sort((a, b) => b.name.length - a.name.length);
  const claimed: Array<[number, number]> = [];
  const found: Array<{ name: string; at: number }> = [];
  for (const m of byLen) {
    if (!m.name) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])(${escapeRe(m.name)})([^\\p{L}\\p{N}_]|$)`, "giu");
    let match: RegExpExecArray | null;
    while ((match = re.exec(t)) !== null) {
      const start = match.index + match[1]!.length;
      if (claimed.some(([s, e]) => start >= s && start < e)) continue; // inside a longer name
      found.push({ name: m.name, at: start });
      claimed.push([start, start + m.name.length]);
      break; // one occurrence per member is enough
    }
  }
  found.sort((a, b) => a.at - b.at);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of found) if (!seen.has(f.name)) { out.push(f.name); seen.add(f.name); }
  return out;
}

/** Build the classification prompt. Priority: recent history > member name > persona;
 *  leader only as fallback / to curb off-topic drift; user turns must pick someone. */
export function buildRouterPrompt(
  history: GroupMessage[], members: GroupMember[], isUserTurn: boolean,
): string {
  const { window, rollingSummary } = buildContextWindow(history, DEFAULT_WINDOW);
  const leader = members.find((m) => m.role === "leader");
  const roster = members
    .map((m) => `- ${m.name}${m.role === "leader" ? " (leader)" : ""}${m.persona ? `: ${m.persona}` : ""}`)
    .join("\n");
  const names = members.map((m) => m.name).join(", ");
  // The AI the user is currently conversing with (spoke most recently).
  const lastSpeaker = [...history].reverse().find((m) => m.fromMember !== "user")?.fromMember;

  const parts = [
    `You route a group chat: decide WHO should speak next. Output member names (or ${NONE}).`,
    `Members:\n${roster}`,
    rollingSummary ? `\nEARLIER (summary):\n${rollingSummary}` : "",
    `\nRECENT MESSAGES:\n${renderWindow(window)}`,
    `\nRules (priority order):`,
    lastSpeaker
      ? `1. CONTINUITY: the user is currently talking with "${lastSpeaker}" (spoke most recently). If this new user message is a reply or instruction directed at them (incl. "assign X", "tell the others", "you do it"), pick "${lastSpeaker}" — even if that's the leader. Only pick someone else if the message clearly targets a different member.`
      : `1. Prefer whoever the RECENT conversation makes most relevant — continue an ongoing thread.`,
    `2. Otherwise, the member NAME being addressed.`,
    `3. Use PERSONA/expertise only for generic questions with no clear thread.`,
    `4. Pick the leader (${leader?.name ?? "leader"}) ONLY if no member clearly fits, or to steer the team back when the discussion drifts off-topic.`,
    `5. PARALLELISM: if several members should respond and can do so INDEPENDENTLY (their replies don't depend on each other), list them ALL — they run in parallel. If a reply must build on another's, list only the ONE who goes next.`,
    `6. WRAP-UP: after the leader (${leader?.name ?? "leader"}) delegated a task and the assigned members have reported back, pick the leader ONCE to summarize the results for the user — then, on the following turn, output ${NONE} to end.`,
    isUserTurn
      ? `This is a reply to the USER — you MUST pick at least one member (never ${NONE}).`
      : `If no one has anything useful to add, output ${NONE} to end the exchange.`,
    `\nAnswer with member name(s) from [${names}]${isUserTurn ? "" : ` or ${NONE}`}, separated by spaces — no other words.`,
  ];
  return parts.filter(Boolean).join("\n");
}

/** Bind a `routeNextSpeaker` fn to a backend + a dedicated router session. Best-effort:
 *  any error / empty / unknown reply → null (the engine forces the leader on user turns
 *  and ends the burst on AI turns). Uses the cheapest model via a per-call override. */
export function makeResponderRouter(
  backend: RouterBackend, providerId: string, sessionId: string,
  opts: { model?: string } = {},
): (ctx: { history: GroupMessage[]; members: GroupMember[]; isUserTurn: boolean }) => Promise<string[]> {
  const model = opts.model ?? ROUTER_MODEL;
  return async ({ history, members, isUserTurn }) => {
    try {
      const prompt = buildRouterPrompt(history, members, isUserTurn);
      let text = "";
      // oneMContext:false — the cheap router model needs no 1M window and may not support it.
      for await (const ev of backend.sendMessage(providerId, sessionId, prompt, { model, permissionMode: "bypassPermissions", oneMContext: false })) {
        if (ev.type === "text") text += ev.content ?? "";
        else if (ev.type === "error") return [];
        else if (ev.type === "done") break;
      }
      return parseResponders(text, members);
    } catch {
      return [];
    }
  };
}
