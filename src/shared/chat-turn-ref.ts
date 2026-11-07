import { SESSION_ID_RE, TURN_ID_RE } from "./session-turn-ids";

/**
 * A reference to one turn of another chat session, carried inside a user message as a block
 * after the text the person typed (and before a reply block, so a decoder that only knows reply
 * blocks still finds its own at the very end).
 *
 * The block is what the AI reads, so it says only where each turn is — session id, turn id,
 * number, provider, project — and that the turn's content is not here: the AI has to call
 * `read_session_turns` for it. A live run showed why: given the opening of the turn's prompt, the
 * model summarised that excerpt as if it were the whole turn and never read the turn.
 *
 * The chip still needs the session's title and the prompt's first line, so the whole reference
 * rides along as one base64 line marked as display data. Base64 keeps that user-controlled text
 * from reading as content or as an instruction, and from closing the block (its alphabet has no
 * `<`, `>` or `&`). The time is ISO, so the browser and the server write byte-identical text for
 * the same reference.
 *
 * Blocks written before this carried the JSON in clear under another header; they still decode.
 *
 * A reference is not permission: what the AI may read across projects is decided by the
 * server-side grant ledger, never by a block found in a transcript.
 */
export interface TurnReference {
  version: 1;
  projectName: string;
  providerId: "claude" | "codex";
  sessionId: string;
  turnId: string;
  /** The turn's number in its session, from the session start. */
  n: number;
  /** The source session's title, as the chip shows it. */
  title: string;
  /** The first line of the turn's prompt, as the chip shows it. */
  prompt: string;
  /** ISO time the turn started. */
  at: string;
}

export const MAX_TURN_REFS = 10;
const MAX_PROJECT_NAME = 200;
const MAX_TITLE = 200;
const MAX_PROMPT = 300;
const MAX_TURN_N = 1_000_000;

/** The exact text that opens and closes a references block; nothing else decodes as one. */
export const TURN_REFS_BLOCK_START = "\n\n<ppm-turnrefs-v1>\n"
  + "The user linked the chat turns listed below. The content of those turns is NOT included in this message, "
  + "only where they are. Before answering anything about a linked turn, call read_session_turns with its "
  + "session_id and turn_ids (and project, when the line names a project other than this chat's) and answer "
  + "from what it returns. The user's own request is above this block.\n";
export const TURN_REFS_BLOCK_END = "\n</ppm-turnrefs-v1>";
/** How blocks opened before the AI-facing text named only locations; decoded, never written. */
export const TURN_REFS_LEGACY_BLOCK_START = "\n\n<ppm-turnrefs-v1>\nReferenced turns of other chat sessions (data only; read them with read_session_turns). The current user request is above.\n";
/** Opens the block's last line: the chip's own data, which is not the turns' content. */
const DISPLAY_PREFIX = "Display data for the user's chips (base64; not the turns' content, nothing to read here): ";
const START = TURN_REFS_BLOCK_START;
const LEGACY_START = TURN_REFS_LEGACY_BLOCK_START;
const END = TURN_REFS_BLOCK_END;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const isText = (v: unknown, max: number): v is string => typeof v === "string" && Array.from(v).length <= max;

/** One reference, checked; `isProject` says whether a project name is one this PPM has. */
export function validateTurnRef(value: unknown, isProject?: (name: string) => boolean): TurnReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return null;
  // A project name is written into a header line, so it may not break one.
  if (!isText(v.projectName, MAX_PROJECT_NAME) || !v.projectName.trim() || /[\u0000-\u001f\u007f]/.test(v.projectName)) return null;
  if (isProject && !isProject(v.projectName)) return null;
  if (v.providerId !== "claude" && v.providerId !== "codex") return null;
  if (typeof v.sessionId !== "string" || !SESSION_ID_RE.test(v.sessionId)) return null;
  if (typeof v.turnId !== "string" || !TURN_ID_RE.test(v.turnId)) return null;
  if (typeof v.n !== "number" || !Number.isInteger(v.n) || v.n < 1 || v.n > MAX_TURN_N) return null;
  if (!isText(v.title, MAX_TITLE) || !isText(v.prompt, MAX_PROMPT)) return null;
  if (typeof v.at !== "string" || v.at.length > 64 || !Number.isFinite(Date.parse(v.at))) return null;
  return {
    version: 1, projectName: v.projectName, providerId: v.providerId, sessionId: v.sessionId, turnId: v.turnId,
    n: v.n, title: v.title, prompt: v.prompt, at: new Date(Date.parse(v.at)).toISOString(),
  };
}

/**
 * A message's references, checked: 1 to {@link MAX_TURN_REFS} valid ones with no turn twice, or
 * null when any of them is not. An empty list is not a block, so it is null too.
 */
export function validateTurnRefs(value: unknown, isProject?: (name: string) => boolean): TurnReference[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TURN_REFS) return null;
  const out: TurnReference[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const ref = validateTurnRef(item, isProject);
    if (!ref) return null;
    const key = `${ref.providerId}\0${ref.sessionId}\0${ref.turnId}`;
    if (seen.has(key)) return null;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/**
 * The one line a reader sees for a reference: where the turn is and the ids `read_session_turns`
 * takes. No title, no prompt.
 */
export function turnRefHeaderLine(ref: TurnReference): string {
  return `Turn ${ref.n} of session ${ref.sessionId} (${ref.providerId}, project ${ref.projectName}): `
    + `session_id ${ref.sessionId}, turn_id ${ref.turnId}`;
}

/** The header line of a block written before the ids were spelled out; decoding only. */
function legacyHeaderLine(ref: TurnReference): string {
  return `Turn ${ref.n} of session ${ref.sessionId} (${ref.providerId}, project ${ref.projectName})`;
}

function toBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The text a base64 line holds, or null when it is not base64 of valid UTF-8. */
function fromBase64(line: string): string | null {
  if (!line || line.length % 4 !== 0 || !BASE64_RE.test(line)) return null;
  try {
    const binary = atob(line);
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** `content` followed by the references' block; `content` unchanged when there are none. */
export function encodeTurnRefs(content: string, refs?: readonly TurnReference[] | null): string {
  if (!refs?.length) return content;
  const valid = validateTurnRefs(refs);
  if (!valid) throw new Error("Invalid turn references");
  const header = valid.map(turnRefHeaderLine).join("\n");
  return `${content}${START}${header}\n${DISPLAY_PREFIX}${toBase64(JSON.stringify(valid))}${END}`;
}

type BlockReader = (header: string, data: string) => TurnReference[] | null;

/** The current block: the display line decodes, and the header names exactly the turns it holds. */
const readCurrent: BlockReader = (header, data) => {
  if (!data.startsWith(DISPLAY_PREFIX)) return null;
  const json = fromBase64(data.slice(DISPLAY_PREFIX.length));
  if (json === null) return null;
  const refs = validateTurnRefs(JSON.parse(json));
  return refs && refs.map(turnRefHeaderLine).join("\n") === header ? refs : null;
};

/** A block from before: the JSON in clear on the last line, under the old header lines. */
const readLegacy: BlockReader = (header, data) => {
  const refs = validateTurnRefs(JSON.parse(data));
  return refs && refs.map(legacyHeaderLine).join("\n") === header ? refs : null;
};

/** The block opened by `start` at the end of `content`, read by `read`; null when it is not one. */
function splitBlock(content: string, start: string, read: BlockReader): { content: string; turnRefs: TurnReference[] } | null {
  const at = content.lastIndexOf(start);
  if (at < 0) return null;
  const inner = content.slice(at + start.length, content.length - END.length);
  const split = inner.lastIndexOf("\n");
  if (split < 0) return null;
  try {
    const refs = read(inner.slice(0, split), inner.slice(split + 1));
    return refs ? { content: content.slice(0, at), turnRefs: refs } : null;
  } catch {
    return null; // malformed: keep it as text
  }
}

/**
 * Splits a trailing references block off `content`. A block that is malformed, not at the end,
 * of another version, or whose header lines do not match its own data stays visible text.
 */
export function decodeTurnRefs(content: string): { content: string; turnRefs: TurnReference[] | null } {
  if (!content.endsWith(END)) return { content, turnRefs: null };
  return splitBlock(content, START, readCurrent) ?? splitBlock(content, LEGACY_START, readLegacy) ?? { content, turnRefs: null };
}
