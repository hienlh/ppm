/**
 * A turn link: the URL of a chat session with `?turn=<turnId>`, as Copy turn link writes it and
 * as a composer recognises it on paste.
 *
 * Recognition goes by the path alone. The origin a link was copied from — localhost, a tunnel,
 * a Tailscale name, an IPv6 literal — says nothing about which PPM it belongs to, so it is ignored.
 * Every decoded segment is checked against the shapes the server accepts, and only a project
 * this PPM has counts: a link that fails any check stays the text it was.
 */
import { SESSION_ID_RE, TURN_ID_RE } from "../../shared/session-turn-ids";

export type TurnLinkProvider = "claude" | "codex";

export interface TurnLinkTarget {
  projectName: string;
  providerId: TurnLinkProvider;
  sessionId: string;
  turnId: string;
}

export interface ParsedTurnLink extends TurnLinkTarget {
  /** The link exactly as it appeared in the pasted text. */
  text: string;
}

/** The link for one turn; `origin` is `location.origin` of the page writing it. */
export function buildTurnLink(origin: string, target: TurnLinkTarget): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/project/${encodeURIComponent(target.projectName)}/chat/${target.providerId}/${target.sessionId}?turn=${encodeURIComponent(target.turnId)}`;
}

/**
 * Where a link's turn is described (`{ title, n, prompt, … }`). Every segment is encoded again
 * here: a pasted `%2F..` decodes to `/..`, and written back raw it would steer this authenticated
 * request to some other route.
 */
export function turnMetaPath(target: TurnLinkTarget): string {
  return `/api/project/${encodeURIComponent(target.projectName)}/chat/sessions/${encodeURIComponent(target.sessionId)}`
    + `/turns/${encodeURIComponent(target.turnId)}?providerId=${encodeURIComponent(target.providerId)}`;
}

/** A turn's stable key, for dedupe: one chip per turn. */
export const turnKey = (t: Pick<TurnLinkTarget, "providerId" | "sessionId" | "turnId">): string =>
  `${t.providerId}/${t.sessionId}/${t.turnId}`;

/**
 * A candidate: an optional `http(s)://host` and then `/project/…`, starting at the beginning of
 * the text or after whitespace or an opening bracket or quote, running to the next whitespace.
 */
const CANDIDATE = /(?<=^|[\s(<[{"'`])(?:https?:\/\/[^\s/?#]+)?\/project\/[^\s]+/g;
const PATH = /^(?:https?:\/\/[^/?#]+)?\/project\/([^/?#]+)\/chat\/(claude|codex)\/([^/?#]+)\/?$/;
/** Sentence punctuation a link is often followed by, never part of one this file writes. */
const TRAILING = /[.,;:!?)\]}>'"`]+$/;
const MAX_PROJECT_NAME = 200;

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** One candidate, checked; null when it is not a turn link this PPM can show. */
function parseOne(raw: string, isProject: (name: string) => boolean): ParsedTurnLink | null {
  const text = raw.replace(TRAILING, "");
  const hashAt = text.indexOf("#");
  const beforeHash = hashAt === -1 ? text : text.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  if (queryAt === -1) return null;
  const path = PATH.exec(beforeHash.slice(0, queryAt));
  if (!path) return null;
  const turnId = new URLSearchParams(beforeHash.slice(queryAt + 1)).get("turn");
  const projectName = decodeSegment(path[1]!);
  const sessionId = decodeSegment(path[3]!);
  if (!turnId || !TURN_ID_RE.test(turnId)) return null;
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return null;
  if (!projectName || projectName.length > MAX_PROJECT_NAME || /[\u0000-\u001f\u007f]/.test(projectName)) return null;
  if (!isProject(projectName)) return null;
  return { text, projectName, providerId: path[2] as TurnLinkProvider, sessionId, turnId };
}

/**
 * Every turn link in `text`, in order and without repeats, and the text with those links taken
 * out. Anything that is not a valid turn link — another kind of chat link, a link to a project
 * this PPM does not have — is left exactly where it was.
 */
export function parseTurnLinks(text: string, isProject: (name: string) => boolean): { links: ParsedTurnLink[]; rest: string } {
  const links: ParsedTurnLink[] = [];
  const seen = new Set<string>();
  let rest = "";
  let last = 0;
  for (const match of text.matchAll(CANDIDATE)) {
    const link = parseOne(match[0], isProject);
    if (!link) continue;
    const start = match.index!;
    rest += text.slice(last, start);
    last = start + link.text.length;
    const key = turnKey(link);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(link);
  }
  return { links, rest: rest + text.slice(last) };
}
