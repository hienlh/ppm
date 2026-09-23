import type { BridgeApi } from "./bridge-core.ts";

/**
 * Live tweak values inside the design document.
 *
 * `tweak-set` writes each value as an inline custom property on the document element, with
 * `important` priority so it shows even where the page's own `:root` rule is `!important`;
 * `tweak-reset` removes them again, which reveals the stylesheet's own value. `tweak-read`
 * answers `tweak-values` with each variable's computed value plus which kind of readable rule
 * sets it last (`root`, `conditional` inside an at-rule or a media-limited sheet, `other`
 * selector, or `unknown` when nothing readable does or a linked sheet the opaque origin
 * cannot read comes after it). That report is a hint for the panel, never a write decision.
 *
 * The parent validates what it sends, and the protocol validates it again, but the frame
 * re-checks the variable name and the value's shape here too: this code runs next to the
 * page's scripts, and a malformed value must never reach `setProperty`. The checks mirror
 * `isSafeTweakValueShape` in `shared/design-tweaks.ts`; shipped as source, this function
 * cannot import it.
 */
export function installTweaks(ppm: BridgeApi): void {
  const doc = ppm.doc;
  const win = ppm.win as Window & typeof globalThis;
  const VAR = /^--[a-zA-Z0-9_-]{1,48}$/;
  const CHARS = /^[A-Za-z0-9 #.,%()-]{1,64}$/;
  const FUNCS = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|calc|min|max|clamp|var)$/i;
  const applied: Record<string, true> = {};

  function safeValue(v: unknown): v is string {
    if (typeof v !== "string" || !CHARS.test(v) || v.trim() !== v || v.indexOf("/*") >= 0 || v.indexOf("*/") >= 0) return false;
    let depth = 0;
    for (let i = 0; i < v.length; i++) {
      if (v[i] === "(") depth++;
      else if (v[i] === ")" && --depth < 0) return false;
    }
    if (depth !== 0) return false;
    const calls = /([A-Za-z-]*)\(/g;
    let m: RegExpExecArray | null;
    while ((m = calls.exec(v))) if (!FUNCS.test(m[1]!)) return false;
    return true;
  }

  function vars(list: unknown): string[] {
    if (!Array.isArray(list)) return [];
    const out: string[] = [];
    for (let i = 0; i < list.length && out.length < 24; i++) if (typeof list[i] === "string" && VAR.test(list[i])) out.push(list[i]);
    return out;
  }

  const root = (): HTMLElement | null => doc.documentElement as HTMLElement | null;

  /** Last readable declaration of `name`, in sheet order, and what kind of rule holds it. */
  function winnerOf(name: string): "root" | "conditional" | "other" | "unknown" {
    let winner: "root" | "conditional" | "other" | "unknown" = "unknown";
    const sheets = doc.styleSheets;
    const walk = (rules: CSSRuleList, conditional: boolean): void => {
      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i] as CSSRule & { selectorText?: string; style?: CSSStyleDeclaration; cssRules?: CSSRuleList };
        if (rule.style && typeof rule.selectorText === "string" && rule.style.getPropertyValue(name) !== "") {
          const sel = rule.selectorText.trim().toLowerCase();
          winner = conditional ? "conditional" : sel === ":root" || sel === "html" ? "root" : "other";
        }
        // Grouping rules (@media, @supports, @layer) and nested style rules.
        if (rule.cssRules && !rule.style) walk(rule.cssRules, true);
      }
    };
    for (let i = 0; i < sheets.length; i++) {
      const sheet = sheets[i]!;
      let rules: CSSRuleList | null = null;
      try {
        rules = sheet.cssRules;
      } catch (e) {
        // A linked sheet: unreadable from the opaque origin, so whatever came before it may lose.
        winner = "unknown";
        continue;
      }
      const media = sheet.media && sheet.media.mediaText ? sheet.media.mediaText.trim().toLowerCase() : "";
      if (rules) walk(rules, media !== "" && media !== "all");
    }
    return winner;
  }

  ppm.on("tweak-set", (m) => {
    const el = root();
    const values = m.values;
    if (!el || !values || typeof values !== "object") return;
    for (const name of Object.keys(values)) {
      const value = (values as Record<string, unknown>)[name];
      if (!VAR.test(name) || !safeValue(value)) continue;
      el.style.setProperty(name, value, "important");
      applied[name] = true;
    }
  });

  ppm.on("tweak-reset", (m) => {
    const el = root();
    if (!el) return;
    const names = m.vars === undefined ? Object.keys(applied) : vars(m.vars);
    for (const name of names) {
      if (!applied[name]) continue;
      el.style.removeProperty(name);
      delete applied[name];
    }
  });

  ppm.on("tweak-read", (m) => {
    const el = root();
    const values: Record<string, string> = {};
    const winners: Record<string, string> = {};
    if (el) {
      const computed = win.getComputedStyle(el);
      for (const name of vars(m.vars)) {
        values[name] = String(computed.getPropertyValue(name) || "").trim().slice(0, 200);
        winners[name] = winnerOf(name);
      }
    }
    ppm.post("tweak-values", { values, winners });
  });
}
