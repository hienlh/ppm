/**
 * Whether a style rule's selector targets the document root, for the `:root` variable
 * scanner. Only a list entry that is exactly `:root` or `html` counts: `html:root`, `:is(...)`
 * and friends are left alone rather than guessed at. `exclusive` means the rule names the
 * root and nothing else, so rewriting one of its declarations cannot restyle other elements.
 */
export function rootSelectorKind(selector: string): { root: boolean; exclusive: boolean } {
  const parts: string[] = [];
  let depth = 0, from = 0;
  const plain = selector.replace(/\/\*[\s\S]*?\*\//g, " ");
  for (let k = 0; k < plain.length; k++) {
    if (plain[k] === "(") depth++;
    else if (plain[k] === ")") depth--;
    else if (plain[k] === "," && depth === 0) { parts.push(plain.slice(from, k)); from = k + 1; }
  }
  parts.push(plain.slice(from));
  const names = parts.map((p) => p.trim().replace(/\s+/g, " ").toLowerCase());
  const root = names.some((n) => n === ":root" || n === "html");
  return { root, exclusive: root && names.length === 1 };
}
