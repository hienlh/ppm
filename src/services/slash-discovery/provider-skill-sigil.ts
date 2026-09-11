/**
 * Swap the leading `/` of a typed command for the sigil the target runtime
 * actually recognises.
 *
 * PPM's picker is slash-driven everywhere, but a provider may resolve its own
 * skills differently — codex activates one from a `$name` mention in the prompt
 * and treats `/name` as ordinary text, so a picked skill would appear to be
 * ignored. Only the sigil changes; arguments after the name are untouched.
 *
 * The rewrite is deliberately conservative: the first word must match a skill
 * the runtime reported, so a slash command the runtime does not own (a PPM
 * built-in, a typo, a bare `/`) is returned exactly as typed.
 */
export function applySkillSigil(content: string, skillNames: Set<string>, sigil: string): string {
  const match = content.match(/^\/(\S+)/);
  const name = match?.[1];
  if (!name || !skillNames.has(name)) return content;
  return sigil + content.slice(1);
}
