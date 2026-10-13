/**
 * Hides secret input values in anything a script prints or throws, before it is stored or shown.
 * Also covers the forms a secret takes once it is put in a URL or a JSON string.
 */
export const SECRET_MASK = "••••";

/** Shorter values are not masked: masking "abc" everywhere would garble the log and hide nothing. */
const MIN_SECRET_LENGTH = 4;

export function secretMasker(secrets: Iterable<unknown>): (text: string) => string {
  const needles = new Set<string>();
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) continue;
    needles.add(secret);
    needles.add(encodeURIComponent(secret));
    needles.add(JSON.stringify(secret).slice(1, -1));
  }
  const list = [...needles].sort((a, b) => b.length - a.length);
  if (list.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const needle of list) if (out.includes(needle)) out = out.split(needle).join(SECRET_MASK);
    return out;
  };
}
