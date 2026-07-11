/**
 * Diff computation + syntax-merge for the compact Edit/MultiEdit preview.
 * Produces an interleaved unified diff (removed lines then added lines per
 * hunk) with char-level highlight on the exact spans that changed, layered on
 * top of highlight.js syntax colors — the same look as Monaco's inline diff.
 */
import hljs from "highlight.js/lib/common";
import { diffLines, diffWordsWithSpace } from "diff";

export type DiffRow =
  | { kind: "equal"; text: string }
  | { kind: "del"; text: string; ranges: Array<[number, number]> }
  | { kind: "ins"; text: string; ranges: Array<[number, number]> };

/** Map file extension to a highlight.js language id; undefined = plain text */
export function hljsLanguage(filePath?: string): string | undefined {
  const ext = filePath?.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp",
    json: "json", css: "css", scss: "scss", less: "less",
    html: "xml", xml: "xml", svg: "xml",
    md: "markdown", mdx: "markdown",
    yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini",
    sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell",
    sql: "sql", php: "php", kt: "kotlin", swift: "swift",
  };
  const lang = map[ext];
  return lang && hljs.getLanguage(lang) ? lang : undefined;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Split a jsdiff chunk value into its constituent lines (drop one trailing \n). */
function toLines(value: string): string[] {
  const v = value.endsWith("\n") ? value.slice(0, -1) : value;
  return v.split("\n");
}

/** Char ranges [start,end) that differ between a removed/added line pair. */
function wordRanges(delLine: string, insLine: string): {
  del: Array<[number, number]>;
  ins: Array<[number, number]>;
} {
  const del: Array<[number, number]> = [];
  const ins: Array<[number, number]> = [];
  let d = 0;
  let i = 0;
  for (const part of diffWordsWithSpace(delLine, insLine)) {
    const len = part.value.length;
    if (part.removed) { del.push([d, d + len]); d += len; }
    else if (part.added) { ins.push([i, i + len]); i += len; }
    else { d += len; i += len; }
  }
  return { del, ins };
}

/** Build the interleaved row model, capped at maxLines. */
export function buildRows(oldStr: string, newStr: string, maxLines: number): {
  rows: DiffRow[];
  extra: number;
} {
  const rows: DiffRow[] = [];
  let delBuf: string[] = [];
  let insBuf: string[] = [];

  const flush = () => {
    const paired = Math.min(delBuf.length, insBuf.length);
    for (let k = 0; k < delBuf.length; k++) {
      const del = delBuf[k]!;
      const ranges = k < paired ? wordRanges(del, insBuf[k]!).del : [];
      rows.push({ kind: "del", text: del, ranges });
    }
    for (let k = 0; k < insBuf.length; k++) {
      const ins = insBuf[k]!;
      const ranges = k < paired ? wordRanges(delBuf[k]!, ins).ins : [];
      rows.push({ kind: "ins", text: ins, ranges });
    }
    delBuf = [];
    insBuf = [];
  };

  for (const part of diffLines(oldStr, newStr)) {
    if (part.added) { insBuf.push(...toLines(part.value)); continue; }
    if (part.removed) { delBuf.push(...toLines(part.value)); continue; }
    flush();
    for (const line of toLines(part.value)) rows.push({ kind: "equal", text: line });
  }
  flush();

  const shown = rows.slice(0, maxLines);
  return { rows: shown, extra: rows.length - shown.length };
}

interface Segment { text: string; cls: string; }

/** Flatten highlight.js HTML into leaf text segments carrying their syntax classes. */
function flattenHtml(html: string): Segment[] {
  const doc = new DOMParser().parseFromString(`<span>${html}</span>`, "text/html");
  const root = doc.body.firstChild;
  const out: Segment[] = [];
  const walk = (node: Node, cls: string) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        out.push({ text: child.textContent ?? "", cls });
      } else if (child.nodeType === 1) {
        const el = child as Element;
        const next = el.className ? (cls ? `${cls} ${el.className}` : el.className) : cls;
        walk(child, next);
      }
    });
  };
  if (root) walk(root, "");
  return out;
}

/**
 * Render one line to injection-safe HTML: syntax colors from hljs, plus a
 * background class on the char ranges that changed. Degrades to plain escaped
 * text (with change highlight) if syntax highlighting throws.
 */
export function renderLine(
  text: string,
  language: string | undefined,
  ranges: Array<[number, number]>,
  changedCls: string,
): string {
  let segments: Segment[];
  if (language) {
    try {
      segments = flattenHtml(hljs.highlight(text, { language }).value);
    } catch {
      segments = [{ text, cls: "" }];
    }
  } else {
    segments = [{ text, cls: "" }];
  }

  const changed = new Array<boolean>(text.length).fill(false);
  for (const [s, e] of ranges) for (let p = s; p < e; p++) changed[p] = true;

  let offset = 0;
  let html = "";
  for (const seg of segments) {
    let i = 0;
    while (i < seg.text.length) {
      const flag = changed[offset + i] ?? false;
      let j = i + 1;
      while (j < seg.text.length && (changed[offset + j] ?? false) === flag) j++;
      const chunk = escapeHtml(seg.text.slice(i, j));
      const cls = [seg.cls, flag ? changedCls : ""].filter(Boolean).join(" ");
      html += cls ? `<span class="${cls}">${chunk}</span>` : chunk;
      i = j;
    }
    offset += seg.text.length;
  }
  return html;
}
