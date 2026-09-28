import type { TweakDef } from "../../../shared/design-tweaks.ts";
import { DesignError } from "../design-error.ts";
import { appendRootBlock, replaceValue, scanRootVars, type CssRootScan } from "./css-root-vars-patch.ts";
import { headEndOffset } from "./html-style-blocks.ts";
import type { StyleSource } from "./design-style-sources.ts";

/**
 * Decides, per tweak, which bytes of which file change — pure, so every cascade case is
 * testable without a disk.
 *
 * The declaration to patch is the one that wins on screen: the **last** declaration of the
 * variable across the page's style sources in cascade order. When that last one is:
 * - in an exclusive top-level `:root`/`html` rule of a design file → its value is replaced;
 * - in a rule shared with other selectors (`:root, .dark`) → a new `:root` block is appended
 *   after it, so only the root changes;
 * - absent → a new `:root` block is appended at the end of the tweak's `file` or else of
 *   the last design stylesheet, never prepended (an earlier block would lose the cascade);
 *   a page with no stylesheet of its own gets a `<style>` at the end of `<head>`;
 * - inside an at-rule or a media-limited sheet, outside the design folder (the shared
 *   `tokens.css`), or anywhere `!important` → refused with an explanation, because any write
 *   the server could make would either not show or restyle every design in the project.
 */

export interface PlannedTweak {
  def: TweakDef;
  /** Already validated against `def`. */
  value: string;
}

const refuse = (message: string): DesignError => new DesignError(422, "ETWEAKTARGET", message);
const eolOf = (text: string): string => (text.includes("\r\n") ? "\r\n" : "\n");

interface Found {
  index: number;
  start: number;
  end: number;
  conditional: boolean;
  atRule: string | null;
  exclusive: boolean;
  important: boolean;
}

/** New text of every file that changes. `texts` holds each source file's current text. */
export function planTweakPatches(
  entry: string,
  sources: readonly StyleSource[],
  texts: ReadonlyMap<string, string>,
  tweaks: readonly PlannedTweak[],
): Map<string, string> {
  const textOf = (file: string): string => {
    const t = texts.get(file);
    if (t === undefined) throw new Error(`no text for style source ${file}`);
    return t;
  };
  const scans = sources.map((s): CssRootScan => scanRootVars(textOf(s.file).slice(s.start, s.end)));
  const writable = (i: number): boolean => !sources[i]!.outside && !sources[i]!.conditional && scans[i]!.endsClean;

  const replacements = new Map<string, { file: string; start: number; end: number; value: string }>();
  const appends = new Map<number, Array<[string, string]>>();
  const newBlock: Array<[string, string]> = [];

  for (const { def, value } of tweaks) {
    const found: Found[] = [];
    sources.forEach((s, index) => {
      for (const d of scans[index]!.declarations) {
        if (d.var !== def.var) continue;
        found.push({
          index, start: s.start + d.valueStart, end: s.start + d.valueEnd, conditional: d.conditional || s.conditional,
          atRule: d.atRule, exclusive: d.exclusive, important: d.important,
        });
      }
    });
    const important = found.find((f) => f.important);
    if (important) {
      throw refuse(`${def.var} is marked !important in ${sources[important.index]!.file}, so a tweak cannot take its place. Ask the AI to drop the !important.`);
    }
    const last = found[found.length - 1];
    const lastFile = last ? sources[last.index]!.file : "";
    if (last && sources[last.index]!.outside) {
      throw refuse(`${def.var} is set last in ${lastFile}, which every design in the project shares. Ask the AI to declare it in this design's own :root instead.`);
    }
    if (last?.conditional) {
      const where = last.atRule ? `an ${last.atRule} block` : "a stylesheet limited by its media attribute";
      throw refuse(`${def.var} is set last inside ${where} in ${lastFile}, so a new value would only apply some of the time. Ask the AI to move it into an unconditional :root block.`);
    }
    if (last?.exclusive) {
      replacements.set(`${lastFile}:${last.start}`, { file: lastFile, start: last.start, end: last.end, value });
      continue;
    }
    // Append. After a shared-selector declaration, the block must come at or after its source.
    const from = last ? last.index : 0;
    const candidates = sources.map((_, i) => i).filter((i) => i >= from && writable(i));
    const preferred = def.file ? candidates.filter((i) => sources[i]!.file === def.file).pop() : undefined;
    const target = preferred ?? candidates.pop();
    if (target !== undefined) {
      appends.set(target, [...(appends.get(target) ?? []), [def.var, value]]);
    } else if (last) {
      throw refuse(`${lastFile} does not end cleanly (an unclosed comment, string or rule), so a :root block for ${def.var} cannot be added after it safely.`);
    } else {
      newBlock.push([def.var, value]);
    }
  }

  // One edit per source region: its in-place replacements first, then its appended block.
  type Edit = { start: number; end: number; text: string };
  const edits = new Map<string, Edit[]>();
  const addEdit = (file: string, edit: Edit) => edits.set(file, [...(edits.get(file) ?? []), edit]);
  const regions = new Set<number>([...appends.keys()]);
  for (const r of replacements.values()) {
    const i = sources.findIndex((s) => s.file === r.file && s.start <= r.start && r.end <= s.end);
    if (i >= 0) regions.add(i);
  }
  const seen = new Set<string>();
  for (const i of [...regions].sort((a, b) => a - b)) {
    const s = sources[i]!;
    const key = `${s.file}:${s.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let css = textOf(s.file).slice(s.start, s.end);
    const inside = [...replacements.values()]
      .filter((r) => r.file === s.file && s.start <= r.start && r.end <= s.end)
      .sort((a, b) => b.start - a.start);
    for (const r of inside) css = replaceValue(css, { valueStart: r.start - s.start, valueEnd: r.end - s.start }, r.value);
    const extra = sources.flatMap((o, j) => (`${o.file}:${o.start}` === key ? appends.get(j) ?? [] : []));
    const next = appendRootBlock(css, extra);
    if (next === null) throw refuse(`${s.file} does not end cleanly, so a :root block cannot be added to it safely.`);
    addEdit(s.file, { start: s.start, end: s.end, text: next });
  }
  if (newBlock.length > 0) {
    const html = textOf(entry);
    const eol = eolOf(html);
    const block = appendRootBlock("", newBlock)!.replace(/\n/g, eol);
    addEdit(entry, { start: headEndOffset(html), end: headEndOffset(html), text: `<style>${eol}${block}</style>${eol}` });
  }

  const out = new Map<string, string>();
  for (const [file, list] of edits) {
    let text = textOf(file);
    for (const e of [...list].sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
    if (text !== textOf(file)) out.set(file, text);
  }
  return out;
}
