import type { ModelOption } from "../../types/chat";

/**
 * A readable name for a model id the provider's model list did not label.
 *
 * The chip shows the list's own label when it has one; this is the fallback for a model the
 * list does not carry (a pinned model, an older session, a list still loading), which
 * otherwise rendered its raw id — `claude-opus-5-5`, the widest thing in a narrow composer.
 * Only ids of a known shape are rewritten, by that shape rather than by a list of names, so a
 * new model needs no change here: `claude-<family>-<major>[-<minor>]` (optionally a `-YYYYMMDD`
 * snapshot) and `gemini-<version>-<name>`, each optionally carrying Antigravity's effort suffix.
 * Anything else is shown as given.
 */
export function modelDisplayName(id: string): string {
  const bare = id.replace(/-(low|medium|high)$/i, "");
  const claude = /^claude-([a-z]+)((?:-\d{1,2})+)(?:-\d{8})?$/i.exec(bare);
  if (claude) {
    const family = claude[1]!;
    const version = claude[2]!.slice(1).split("-").join(".");
    return `${family[0]!.toUpperCase()}${family.slice(1)} ${version}`;
  }
  const gemini = /^gemini-(\d+(?:\.\d+)?)((?:-[a-z]+)+)$/i.exec(bare);
  if (gemini) {
    const words = gemini[2]!.slice(1).split("-").map((w) => w[0]!.toUpperCase() + w.slice(1));
    return `Gemini ${gemini[1]} ${words.join(" ")}`;
  }
  return id;
}

/** The "Auto" entry of a model select: names the model the provider picks, when its list says. */
export function autoModelLabel(models: ModelOption[]): string {
  const picked = models.find((m) => m.isDefault);
  return picked ? `Auto (${picked.label})` : "Auto (default)";
}
