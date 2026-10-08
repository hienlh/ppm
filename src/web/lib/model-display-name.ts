/**
 * A readable name for a model id the provider's model list did not label.
 *
 * The chip shows the list's own label when it has one; this is the fallback for a model the
 * list does not carry (a pinned default, an older session, a list still loading), which
 * otherwise rendered its raw id — `claude-opus-5-5`, the widest thing in a narrow composer.
 * Only Claude ids are rewritten: their shape is known (`claude-<family>-<major>[-<minor>]`,
 * optionally a `-YYYYMMDD` snapshot). Anything else is shown as given.
 */
export function modelDisplayName(id: string): string {
  const match = /^claude-([a-z]+)((?:-\d{1,2})+)(?:-\d{8})?$/i.exec(id);
  if (!match) return id;
  const family = match[1]!;
  const version = match[2]!.slice(1).split("-").join(".");
  return `${family[0]!.toUpperCase()}${family.slice(1)} ${version}`;
}
