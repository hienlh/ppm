/**
 * The card a script schedule proposal is approved on, for a chat's tool and the PPM Assistant's
 * alike. A script runs code on this machine as the user every time it fires, with nobody
 * watching, so the card shows what will run and where, verbatim: the whole script as the body,
 * the folder it runs in, the cron with its zone and next three runs, the timeout, every input's
 * value, the mode its AI turns run in, the chats the script names and the file it came from.
 *
 * Every fact is the server's own reading of the checked proposal. The one exception is the
 * description, which is the AI's (or the file's) own words and says so. The chats are found by
 * the server, not taken from the AI: every chat id written in the script or an input value.
 *
 * `reviewInPpm` is always set: such a card is allowed only in PPM, where the whole script is on
 * screen, never from Telegram or by the Assistant answering for the user.
 */
import type { ApprovalFact, ApprovalSummary } from "../../shared/assistant-approval.ts";
import type { ScheduleInputDecl, ScheduleInputValue } from "../../types/scheduler.ts";
import { exactFact, fact, modeLabel } from "../assistant-mcp/assistant-approval-summary.ts";
import { timeoutLabel } from "../assistant-mcp/assistant-approval-summary-schedule.ts";
import type { ScriptScheduleProposal } from "./script-proposal.ts";

export const SCRIPT_UNATTENDED_WARNING = "Nobody watches this: the script runs on this machine as you — your files, your "
  + "network, your accounts — every time it fires, and no one checks a run before it happens. Allow it only if you "
  + "have read all of it.";

export const SCRIPT_REVIEW_IN_PPM = "A script schedule runs code unattended, so it can only be allowed in PPM, where the "
  + "whole script is shown. It can be denied from here.";

/** The most chats a card lists by name; more are counted. */
const MAX_CHATS_LISTED = 10;
const CHAT_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export interface KnownChat {
  title: string | null;
  projectName: string | null;
}

export interface ProposalCardDeps {
  /** The next `n` fires of `cron` read in `zone` (the machine's when null), on that zone's clock. */
  nextRuns(cron: string, zone: string | null, n: number): string[];
  machineZone: string;
  /** The chat PPM knows by this id, or null. */
  chat(sessionId: string): KnownChat | null;
}

const providerName = (id: string): string => (id === "codex" ? "Codex" : id === "claude" ? "Claude" : id);

/** Every chat id the script and the input values name, each once, in the order they appear. */
export function namedChatIds(p: Pick<ScriptScheduleProposal, "script" | "inputs" | "inputValues">): string[] {
  const texts = [
    ...p.inputs.map((d) => String((Object.hasOwn(p.inputValues, d.key) ? p.inputValues[d.key] : undefined) ?? d.default ?? "")),
    p.script,
  ];
  const ids: string[] = [];
  for (const text of texts) for (const m of text.matchAll(CHAT_ID)) {
    const id = m[0].toLowerCase();
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * The chats the script names, found by the server. What the script may reach beyond them is said
 * as a fact about every script, never guessed from its text: code can call `ctx.ai.chat` or
 * `ctx.notify` under any spelling, and a chat it names can be in any project.
 */
function chatFacts(p: ScriptScheduleProposal, deps: ProposalCardDeps): ApprovalFact[] {
  const ids = namedChatIds(p);
  const facts: ApprovalFact[] = [];
  for (const id of ids.slice(0, MAX_CHATS_LISTED)) {
    const chat = deps.chat(id);
    if (!chat) {
      facts.push(exactFact("Names a chat id", `${id} — no chat PPM knows`));
      continue;
    }
    const where = chat.projectName && chat.projectName !== p.project.name ? ` — in another project, "${chat.projectName}"` : "";
    facts.push(exactFact("Sends to chat", `${chat.title ?? "Untitled chat"} (${id})${where}`, where ? "warning" : undefined));
  }
  if (ids.length > MAX_CHATS_LISTED) facts.push(fact("More chat ids", `${ids.length - MAX_CHATS_LISTED} more in the script and inputs`));
  if (ids.length === 0) facts.push(fact("Sends to chat", "No chat id is written in the script or its inputs"));
  facts.push(fact("It can also reach",
    "Any chat, by id, or a new one it opens (ctx.ai.chat); your notifications (ctx.notify); and whatever you can reach "
    + "on this machine. Only the script below says which it does."));
  return facts;
}

/**
 * A value as the script receives it: text verbatim between quotes (JSON would double every
 * backslash of a Windows path, which is not the value that runs), a number or a boolean bare.
 */
export const inputValueShown = (v: ScheduleInputValue): string => (typeof v === "string" ? `"${v}"` : String(v));

function inputValueText(d: ScheduleInputDecl, values: ScriptScheduleProposal["inputValues"]): string {
  if (d.type === "secret") return "(secret — set by you in Settings → Schedules; none now)";
  if (Object.hasOwn(values, d.key)) return inputValueShown(values[d.key]!);
  if (d.default !== undefined) return `${inputValueShown(d.default)} (its default)`;
  return "(empty)";
}

function whenFacts(p: ScriptScheduleProposal, deps: ProposalCardDeps): ApprovalFact[] {
  if (p.mode === "always-on") {
    return [fact("Runs", "Always on: PPM keeps it running and starts it again after a crash, until it is paused", "warning")];
  }
  const zone = p.timezone ?? deps.machineZone;
  const runs = deps.nextRuns(p.cron!, p.timezone, 3);
  return [
    exactFact("Cron", p.cron!),
    exactFact("Time zone", p.timezone ? zone : `${zone} (this machine's)`),
    fact("Next 3 runs", runs.length ? `${runs.join(", ")} (${zone})` : "Never: this expression does not fire again"),
    fact("Timeout", `${timeoutLabel(p.timeoutMs!)} per run, then it is stopped`),
  ];
}

/** A stored script schedule as a raw row (`inputs_json`) or as the routes' view (`inputs`). */
type StoredScript = { script: string | null; inputs_json?: string; input_values_json?: string; inputs?: ScheduleInputDecl[]; inputValues?: Record<string, ScheduleInputValue> };

function storedInputs(s: StoredScript): { inputs: ScheduleInputDecl[]; values: Record<string, ScheduleInputValue> } {
  const parse = <T>(text: string | undefined, fallback: T): T => {
    try { return text ? JSON.parse(text) as T : fallback; } catch { return fallback; }
  };
  return {
    inputs: s.inputs ?? parse<ScheduleInputDecl[]>(s.inputs_json, []),
    values: s.inputValues ?? parse<Record<string, ScheduleInputValue>>(s.input_values_json, {}),
  };
}

/**
 * `summary` with a stored script made the thing approved: its code as the body, every input's
 * value as a fact, the unattended warning, and allowed only in PPM. For any card that starts,
 * runs or changes what an existing script schedule does (turning it on, run now, a new project or
 * mode); pausing one needs none of it.
 */
export function withStoredScript(summary: ApprovalSummary, s: StoredScript): ApprovalSummary {
  const { inputs, values } = storedInputs(s);
  return {
    ...summary,
    facts: [...summary.facts, ...inputs.map((d) => exactFact(`Input ${d.key}`, inputValueText(d, values)))],
    body: { label: "Script (runs exactly as shown)", text: s.script ?? "", format: "code" },
    warning: SCRIPT_UNATTENDED_WARNING,
    reviewInPpm: SCRIPT_REVIEW_IN_PPM,
  };
}

export function scriptProposalSummary(p: ScriptScheduleProposal, providerId: string, deps: ProposalCardDeps): ApprovalSummary {
  const bypass = p.permissionMode === "bypassPermissions";
  return {
    headline: `Create the script schedule "${p.name}" in "${p.project.name}": it runs code on this machine with nobody watching`,
    facts: [
      exactFact("Name", p.name),
      exactFact("Project", p.project.name),
      exactFact("Runs in folder", p.project.path),
      ...whenFacts(p, deps),
      ...chatFacts(p, deps),
      ...p.inputs.map((d) => exactFact(`Input ${d.key}`, inputValueText(d, p.inputValues))),
      fact("Its AI turns run in", `${modeLabel(p.permissionMode)}${p.modeChosen ? "" : " — the default, as in the Settings form"}`, bypass ? "warning" : undefined),
      fact("New chats on", `${providerName(providerId)} (the default provider; the schedule keeps it)`),
      ...(p.file ? [
        exactFact("From file", p.file.path),
        fact("File SHA-256", `${p.file.sha256} — if the file changes before you answer, nothing is created`),
      ] : []),
      ...(p.description ? [exactFact("Description (the AI's words, not checked)", p.description)] : []),
      fact("After you allow", "It is created on and runs at its next fire; pause or delete it in Settings → Schedules"),
    ],
    body: { label: "Script (runs exactly as shown)", text: p.script, format: "code" },
    warning: SCRIPT_UNATTENDED_WARNING,
    reviewInPpm: SCRIPT_REVIEW_IN_PPM,
  };
}
