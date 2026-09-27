/**
 * Skills named inside the user's design instructions (Settings → Design).
 *
 * The instructions are one global text, but a skill is only real for the runtime that
 * loads it: a Claude session resolves `/ak:ui-ux-pro-max` through its plugin registry, a
 * Codex session through `skills/list`. So a mention is parsed here once, provider-neutral,
 * and resolved separately against each runtime's own list. Shared by the server (which
 * turns a resolved mention into a directive) and the settings pane (which shows which
 * mentions resolve where), so the two can never disagree about what counts as a mention.
 */

/** What a mention is resolved against: a slash item's name plus the aliases discovery kept. */
export interface SkillCandidate {
  name: string;
  aliases?: string[];
}

export interface MentionResolution<T extends SkillCandidate = SkillCandidate> {
  resolved: Array<{ mention: string; skill: T }>;
  unresolved: string[];
}

/** More than this is not a design method any more, and each one costs a directive line. */
export const MAX_SKILL_MENTIONS = 16;

export const DESIGN_INSTRUCTIONS_MAX_BYTES = 8 * 1024;

/**
 * A mention opens a word — start of text, whitespace or an opening bracket or quote — with
 * `/` (every picker in PPM) or `$` (what codex itself uses and what the picker inserts for a
 * codex skill). Requiring the word boundary keeps a path like `src/app` or the `/pricing` of
 * a URL from counting. Names start with a lowercase letter, as skill names do by
 * convention, which also keeps shell variables (`$HOME`) and prices (`$29/mo`) out. A page
 * route such as `/pricing` still looks like a mention; the prompt says to read an
 * unresolved one as ordinary text.
 */
const MENTION_RE = /(^|[\s([{"'`])[/$]([a-z][a-z0-9._-]*(?::[a-z0-9._-]+)*(?:\/[a-z0-9._-]+)*)/g;

/** Sentence punctuation that the name pattern accepts but no name ends with. */
const TRAILING_PUNCTUATION_RE = /[._:-]+$/;

/** The mentioned names in order of first appearance, without their sigil, deduplicated. */
export function extractSkillMentions(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION_RE)) {
    const name = (match[2] ?? "").replace(TRAILING_PUNCTUATION_RE, "");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (seen.size >= MAX_SKILL_MENTIONS) break;
  }
  return [...seen];
}

/** The part after a plugin or kit namespace: `ak-engineer:ak-debug` → `ak-debug`. */
function baseName(name: string): string {
  const colon = name.lastIndexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * The installed skill a mention means, or null.
 *
 * Exact name first, then an alias (AgentKit's declared `ak:debug` for the registered
 * `ak-engineer:ak-debug`), then the un-namespaced name — which is what lets one global
 * text written as `/ak:ui-ux-pro-max` also find a codex skill registered as plain
 * `ui-ux-pro-max`, and the reverse. The first match wins, following discovery order, the
 * same rule the chat composer applies to a typed alias.
 */
export function resolveSkillMention<T extends SkillCandidate>(mention: string, candidates: readonly T[]): T | null {
  const exact = candidates.find((c) => c.name === mention);
  if (exact) return exact;
  const alias = candidates.find((c) => c.aliases?.includes(mention));
  if (alias) return alias;
  const base = baseName(mention);
  return candidates.find((c) => baseName(c.name) === base || c.aliases?.some((a) => baseName(a) === base)) ?? null;
}

export function resolveSkillMentions<T extends SkillCandidate>(
  mentions: readonly string[],
  candidates: readonly T[],
): MentionResolution<T> {
  const resolved: MentionResolution<T>["resolved"] = [];
  const unresolved: string[] = [];
  for (const mention of mentions) {
    const skill = resolveSkillMention(mention, candidates);
    if (skill) resolved.push({ mention, skill });
    else unresolved.push(mention);
  }
  return { resolved, unresolved };
}

/** UTF-8 size, which is what the cap is about: the text ends up in every design prompt. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export type NormalizedInstructions = { ok: true; text: string } | { ok: false; error: string };

/**
 * Validate a submitted instructions text. Line endings are folded to LF and the ends
 * trimmed, so a text saved from Windows and one saved from a phone compare equal; a NUL
 * is refused rather than stripped because no editor produces one.
 */
export function normalizeDesignInstructions(value: unknown): NormalizedInstructions {
  if (typeof value !== "string") return { ok: false, error: "instructions must be a string" };
  if (value.includes("\u0000")) return { ok: false, error: "instructions must not contain NUL characters" };
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (utf8ByteLength(text) > DESIGN_INSTRUCTIONS_MAX_BYTES) {
    return { ok: false, error: `instructions must be ${DESIGN_INSTRUCTIONS_MAX_BYTES / 1024} KB or less` };
  }
  return { ok: true, text };
}
