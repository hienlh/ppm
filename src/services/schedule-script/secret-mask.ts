/**
 * Hides secret input values in anything a script prints or throws, before it is stored or shown.
 * Also covers the forms a secret takes once it is put in a URL or a JSON string.
 */
export const SECRET_MASK = "••••";

/** Shorter values are not masked: masking "abc" everywhere would garble the log and hide nothing. */
const MIN_SECRET_LENGTH = 4;

/**
 * `cutAtEnd`: the text was cut short and may stop partway through a secret, so the longest end of
 * it that starts one is masked too — at the price of masking a few characters that only look like
 * the start of a secret.
 */
export function secretMasker(secrets: Iterable<unknown>): (text: string, cutAtEnd?: boolean) => string {
  const needles = new Set<string>();
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) continue;
    needles.add(secret);
    needles.add(encodeURIComponent(secret));
    needles.add(JSON.stringify(secret).slice(1, -1));
  }
  const list = [...needles].sort((a, b) => b.length - a.length);
  if (list.length === 0) return (text) => text;
  return (text, cutAtEnd = false) => {
    let out = text;
    for (const needle of list) if (out.includes(needle)) out = out.split(needle).join(SECRET_MASK);
    return cutAtEnd ? maskCutEnd(out, list) : out;
  };
}

/** Masks the longest end of `text` that is the start of a needle; a whole needle is already masked. */
function maskCutEnd(text: string, needles: string[]): string {
  let longest = 0;
  for (const needle of needles) {
    for (let k = Math.min(needle.length - 1, text.length); k > longest; k--) {
      if (text.endsWith(needle.slice(0, k))) {
        longest = k;
        break;
      }
    }
  }
  return longest > 0 ? text.slice(0, text.length - longest) + SECRET_MASK : text;
}
