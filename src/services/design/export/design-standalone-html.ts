import { posix } from "node:path";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { DesignError } from "../design-error.ts";
import { decodeDesignText, MAX_DESIGN_SOURCE_BYTES } from "../source/design-source-file.ts";
import { headInsertOffset } from "../preview/html-instrument.ts";
import type { ReadAsset } from "./design-export-asset-reader.ts";
import { inlineCssUrls, loadInlineAsset, resolveDesignRef, toDataUri, type InlineContext } from "./css-url-inline.ts";

/**
 * One design page as a single self-contained HTML file: local stylesheets, scripts, images
 * and media become inline `<style>`/`<script>` or `data:` URIs; CDN references stay as they
 * are (they are allowed and not local).
 *
 * Like the canvas instrumentation, this splices at parse5 source locations and never
 * re-serialises the document, so everything not being inlined is byte-for-byte the source.
 * An inlined script has `</script` escaped, and a `defer`/`async` script keeps its timing by
 * becoming a `data:` `src` rather than inline text. Local ES-module imports are not bundled;
 * they are reported. `readAsset` is injected so the whole thing is testable without a disk.
 */

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

export const STANDALONE_ASSET_LIMIT = 10 * 1024 * 1024;
export const STANDALONE_TOTAL_LIMIT = 30 * 1024 * 1024;

export interface StandaloneHtml {
  html: string;
  warnings: string[];
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

const isElement = (node: Node): node is Element => "tagName" in node;
const attrOf = (el: Element, name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value;
const escapeAttr = (v: string): string => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const LOCAL_IMPORT_RE = /\bimport\s*(?:[\w$*{}\s,]+\s*from\s*)?\(?\s*["'](\.{1,2}\/[^"']*)["']/g;

export async function buildStandaloneHtml(
  entryRel: string,
  readAsset: ReadAsset,
  limits: { perAsset: number; total: number } = { perAsset: STANDALONE_ASSET_LIMIT, total: STANDALONE_TOTAL_LIMIT },
): Promise<StandaloneHtml> {
  const entry = await readAsset(entryRel, MAX_DESIGN_SOURCE_BYTES);
  if (!entry.ok) {
    throw entry.reason === "missing" ? new DesignError(404, "ENOENT", `Page not found: ${entryRel}`)
      : entry.reason === "too-large" ? new DesignError(413, "ETOOBIG", "Page too large to export")
      : new DesignError(403, "EDESIGNPATH", "Page is not readable from the design folder");
  }
  const { text } = decodeDesignText(entry.bytes, { lossy: true });
  const ctx: InlineContext = { readAsset, budget: { perAsset: limits.perAsset, remaining: limits.total }, warnings: [] };
  const baseDir = posix.dirname(entryRel);
  const edits: Edit[] = [];
  const reportImports = (code: string, where: string): void => {
    for (const m of code.matchAll(LOCAL_IMPORT_RE)) ctx.warnings.push(`${where}: imports ${m[1]}, which is not bundled`);
  };
  const localRef = (ref: string | undefined) => {
    if (ref === undefined) return null;
    const resolved = resolveDesignRef(ref, baseDir);
    if (resolved && "outside" in resolved) {
      ctx.warnings.push(`${ref}: outside the design folder, left linked`);
      return null;
    }
    return resolved;
  };
  const inlineAttr = async (el: Element, name: string): Promise<void> => {
    const loc = el.sourceCodeLocation?.attrs?.[name];
    const ref = localRef(attrOf(el, name));
    if (!loc || !ref) return;
    const bytes = await loadInlineAsset(ref.rel, ctx);
    if (bytes) edits.push({ start: loc.startOffset, end: loc.endOffset, text: `${name}="${toDataUri(ref.rel, bytes)}${ref.suffix}"` });
  };

  const doc = parse(text, { sourceCodeLocationInfo: true });
  const stack: Node[] = [...doc.childNodes].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (!isElement(node)) continue;
    const loc = node.sourceCodeLocation;
    const tag = node.tagName;
    const children = tag === "template" ? (node as DefaultTreeAdapterMap["template"]).content.childNodes : node.childNodes;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
    if (!loc?.startTag) continue;

    if (tag === "link" && (attrOf(node, "rel") ?? "").toLowerCase().split(/\s+/).includes("stylesheet")) {
      const ref = localRef(attrOf(node, "href"));
      const bytes = ref ? await loadInlineAsset(ref.rel, ctx) : null;
      if (!ref || !bytes) continue;
      const css = await inlineCssUrls(new TextDecoder().decode(bytes), posix.dirname(ref.rel), ctx);
      const media = attrOf(node, "media");
      edits.push({
        start: loc.startTag.startOffset, end: loc.endTag?.endOffset ?? loc.startTag.endOffset,
        text: `<style${media ? ` media="${escapeAttr(media)}"` : ""}>${css.replace(/<\/style/gi, "<\\/style")}</style>`,
      });
      continue;
    }
    if (tag === "script") {
      const module = (attrOf(node, "type") ?? "").trim().toLowerCase() === "module";
      const src = attrOf(node, "src");
      if (src === undefined) {
        if (module) reportImports(node.childNodes.map((c) => ("value" in c ? String(c.value) : "")).join(""), "inline module script");
        continue;
      }
      const ref = localRef(src);
      const bytes = ref ? await loadInlineAsset(ref.rel, ctx) : null;
      if (!ref || !bytes) continue;
      const code = new TextDecoder().decode(bytes);
      if (module) reportImports(code, ref.rel);
      const timed = !module && (attrOf(node, "defer") !== undefined || attrOf(node, "async") !== undefined);
      const srcLoc = loc.attrs?.src;
      if (timed && srcLoc) {
        edits.push({ start: srcLoc.startOffset, end: srcLoc.endOffset, text: `src="${toDataUri(ref.rel, bytes)}"` });
      } else if (loc.endTag) {
        const kept = node.attrs.filter((a) => !["src", "integrity", "crossorigin", "charset", "defer", "async"].includes(a.name))
          .map((a) => ` ${a.name}="${escapeAttr(a.value)}"`).join("");
        edits.push({ start: loc.startTag.startOffset, end: loc.endTag.endOffset, text: `<script${kept}>${code.replace(/<\/script/gi, "<\\/script")}</script>` });
      }
      continue;
    }
    if (tag === "style") {
      const first = node.childNodes[0];
      const textLoc = first?.sourceCodeLocation;
      if (first && "value" in first && textLoc) {
        const css = await inlineCssUrls(String(first.value), baseDir, ctx);
        if (css !== first.value) edits.push({ start: textLoc.startOffset, end: textLoc.endOffset, text: css });
      }
      continue;
    }
    const style = attrOf(node, "style");
    const styleLoc = loc.attrs?.style;
    if (style !== undefined && styleLoc && /url\(/i.test(style)) {
      const css = await inlineCssUrls(style, baseDir, ctx);
      if (css !== style) edits.push({ start: styleLoc.startOffset, end: styleLoc.endOffset, text: `style="${escapeAttr(css)}"` });
    }
    if (tag === "img" || tag === "source" || tag === "video" || tag === "audio" || tag === "track") await inlineAttr(node, "src");
    if (tag === "video") await inlineAttr(node, "poster");
    const srcset = attrOf(node, "srcset");
    const srcsetLoc = loc.attrs?.srcset;
    if ((tag === "img" || tag === "source") && srcset !== undefined && srcsetLoc && !/^\s*data:/i.test(srcset)) {
      const candidates = srcset.split(/,\s+/).map((c) => c.trim()).filter(Boolean);
      const [url, ...descriptor] = (candidates[0] ?? "").split(/\s+/);
      const ref = localRef(url);
      const bytes = ref ? await loadInlineAsset(ref.rel, ctx) : null;
      if (ref && bytes) {
        edits.push({ start: srcsetLoc.startOffset, end: srcsetLoc.endOffset, text: `srcset="${[toDataUri(ref.rel, bytes), ...descriptor].join(" ")}"` });
        if (candidates.length > 1) ctx.warnings.push(`${ref.rel}: srcset keeps only its first image`);
      }
    }
  }

  // Without a declared charset a file opened from disk may be read as Windows-1252.
  if (!/<meta\s[^>]*charset/i.test(text)) edits.push({ start: headInsertOffset(text), end: headInsertOffset(text), text: '<meta charset="utf-8">' });
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  const out: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue;
    out.push(text.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  out.push(text.slice(cursor));
  return { html: out.join(""), warnings: ctx.warnings };
}
