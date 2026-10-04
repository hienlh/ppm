/**
 * File icons for an extension panel.
 *
 * A panel is a sandboxed document of its own, so the icon stylesheet the app's
 * trees draw with never reaches it, and the Git Graph's file lists drew one
 * generic page glyph for every file. Handing the panel the whole stylesheet
 * would be 1.9 MB for a list of eight files. So the panel posts
 * `{ command: "__ppm.fileIcons", names }` and the app answers with each name's
 * glyph class, resolved exactly as `FileIcon` resolves it, and the drawings of
 * just those classes, read from the stylesheet it already loaded.
 *
 * The light-theme drawings are keyed on `:root.light` in the app; a panel has
 * no such class and says its theme with `data-ppm-theme` (`webview-theme.ts`),
 * so those rules are rewritten on the way out.
 */
import { fileIconName } from "@/lib/file-icon-name";
import type { IconFramework } from "@/lib/file-icons.generated";

export const FILE_ICONS_COMMAND = "__ppm.fileIcons";

/** More than any list a panel draws at once; a bound on what one message can make the app do. */
const MAX_NAMES = 500;

/**
 * `undefined` when the message is anything else (forward it to the extension
 * as usual); otherwise the file names asked about.
 */
export function fileIconsRequest(data: unknown): string[] | undefined {
  if (!data || typeof data !== "object" || (data as { command?: unknown }).command !== FILE_ICONS_COMMAND) return undefined;
  const names = (data as { names?: unknown }).names;
  if (!Array.isArray(names)) return [];
  return names.filter((n): n is string => typeof n === "string").slice(0, MAX_NAMES);
}

/** What is read of a `CSSStyleRule`; a plain object in a test. */
export interface IconRule {
  selectorText: string;
  style: { backgroundImage: string };
}

/** Each glyph class's rules: the drawing, and the light theme's own where it has one. */
export type IconRuleIndex = Map<string, { dark?: IconRule; light?: IconRule }>;

/**
 * Indexed by selector only — serialising every rule's drawing up front would
 * read the whole 1.9 MB to answer for a handful of them.
 */
export function indexIconRules(rules: Iterable<object>): IconRuleIndex {
  const index: IconRuleIndex = new Map();
  for (const rule of rules) {
    if (!("selectorText" in rule)) continue;
    const r = rule as IconRule;
    const m = /^(:root\.light )?\.(vsi-[\w-]+)$/.exec(r.selectorText);
    if (!m) continue;
    const cls = m[2]!;
    const entry = index.get(cls) ?? {};
    entry[m[1] ? "light" : "dark"] = r;
    index.set(cls, entry);
  }
  return index;
}

export interface FileIconsAnswer {
  command: typeof FILE_ICONS_COMMAND;
  /** `[name, class]` pairs rather than an object, so a file named `__proto__` is just a name. */
  icons: [string, string][];
  /** `[class, css]`: each class once, with its light-theme rule when it has one. */
  rules: [string, string][];
}

export function fileIconsAnswer(names: readonly string[], framework: IconFramework | null, index: IconRuleIndex): FileIconsAnswer {
  const icons: [string, string][] = [];
  const rules: [string, string][] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const cls = `vsi-${fileIconName(name, framework)}`;
    icons.push([name, cls]);
    if (seen.has(cls)) continue;
    seen.add(cls);
    const entry = index.get(cls);
    let css = "";
    if (entry?.dark) css += `.${cls} { background-image: ${entry.dark.style.backgroundImage}; }\n`;
    if (entry?.light) css += `:root[data-ppm-theme="light"] .${cls} { background-image: ${entry.light.style.backgroundImage}; }\n`;
    if (css) rules.push([cls, css]);
  }
  return { command: FILE_ICONS_COMMAND, icons, rules };
}
