/**
 * A readable name for a model id the provider's model list did not label.
 *
 * The chip shows the list's own label when it has one; this is the fallback for a model the
 * list does not carry (a pinned default, an older session, a list still loading), which
 * otherwise rendered its raw id — `claude-opus-5-5`, the widest thing in a narrow composer.
 * Only Claude ids are rewritten: their shape is known (`claude-<family>-<major>[-<minor>]`,
 * optionally a `-YYYYMMDD` snapshot). Anything else is shown as given.
 */
const ANTIGRAVITY_MODEL_LABELS: Record<string, string> = {
  "gemini-4-argon": "Gemini 4 Argon",
  "gemini-4-argon-medium": "Gemini 4 Argon",
  "gemini-4-argon-high": "Gemini 4 Argon",
  "gemini-4-argon-low": "Gemini 4 Argon",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "gemini-3.8-flash-high": "Gemini 3.8 Flash",
  "gemini-3.8-flash-medium": "Gemini 3.8 Flash",
  "gemini-3.8-flash-low": "Gemini 3.8 Flash",
  "claude-opus-5-5-low": "Claude Opus 5.5",
  "claude-opus-5-5-medium": "Claude Opus 5.5",
  "claude-opus-5-5-high": "Claude Opus 5.5",
  "claude-sonnet-5-5-low": "Claude Sonnet 5.5",
  "claude-sonnet-5-5-medium": "Claude Sonnet 5.5",
  "claude-sonnet-5-5-high": "Claude Sonnet 5.5",
  "gpt-oss-120b": "GPT-OSS 120B",
  "gpt-oss-120b-medium": "GPT-OSS 120B",
};

export function modelDisplayName(id: string): string {
  if (ANTIGRAVITY_MODEL_LABELS[id]) return ANTIGRAVITY_MODEL_LABELS[id]!;
  const match = /^claude-([a-z]+)((?:-\d{1,2})+)(?:-\d{8})?$/i.exec(id);
  if (!match) return id;
  const family = match[1]!;
  const version = match[2]!.slice(1).split("-").join(".");
  return `${family[0]!.toUpperCase()}${family.slice(1)} ${version}`;
}
