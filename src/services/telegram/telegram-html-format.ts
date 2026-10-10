/**
 * Markdown, as a model writes it, turned into the HTML subset Telegram's `parse_mode: "HTML"`
 * accepts — and cut into messages Telegram will take.
 *
 * Telegram refuses a whole message over one stray `<` or `&` ("can't parse entities"), over a
 * tag it does not know, or over tags that cross. So text is escaped before any formatting is
 * added, every tag this file emits is closed on the line that opened it, and the splitter closes
 * whatever is open at a cut and opens it again in the next message. Telegram has no headings and
 * no tables: a heading becomes bold, a table becomes aligned monospace text. A link is shown as
 * `text (url)` so the person sees where it goes before tapping it.
 */
import { escapeTelegramHtml } from "../notification-format.ts";
import { redactLogText } from "../../shared/log-redact.ts";

export const TELEGRAM_MESSAGE_MAX = 4096;

const escape = escapeTelegramHtml;

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^\n]*$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

export function markdownToTelegramHtml(md: string): string {
  // NUL is the placeholder marker below; it has no business in a chat message anyway.
  const lines = md.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      // An unclosed fence runs to the end, as Markdown renders it.
      while (i < lines.length && !isFenceClose(lines[i]!, marker)) body.push(lines[i++]!);
      i++;
      out.push(codeBlock(body.join("\n"), fence[2] ?? ""));
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const rows = [line];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(lines[i++]!);
      out.push(tableBlock(rows));
      continue;
    }

    out.push(formatLine(line));
    i++;
  }
  return out.join("\n");
}

function isFenceClose(line: string, marker: string): boolean {
  const t = line.trim();
  return t.length >= marker.length && t[0] === marker[0] && /^(`+|~+)$/.test(t);
}

function isTableSeparator(line: string): boolean {
  return line.includes("|") && line.includes("-") && TABLE_SEPARATOR.test(line);
}

function codeBlock(code: string, lang: string): string {
  const body = escape(code.replace(/\s+$/, ""));
  const safeLang = lang.replace(/[^\w+#-]/g, "");
  return safeLang ? `<pre><code class="language-${safeLang}">${body}</code></pre>` : `<pre>${body}</pre>`;
}

function formatLine(line: string): string {
  const heading = HEADING.exec(line);
  // Bold inside bold adds nothing, so a heading's own `**` markers are dropped.
  if (heading) return `<b>${formatInline(heading[1]!.replace(/\*\*|__/g, ""))}</b>`;
  if (RULE.test(line)) return "──────────";
  const bullet = BULLET.exec(line);
  if (bullet) return `${bullet[1]}• ${formatInline(bullet[2]!)}`;
  return formatInline(line);
}

/** Cell text with inline Markdown markers removed — a `<pre>` shows them literally. */
function plainCell(cell: string): string {
  return cell
    .replace(/\\\|/g, "|")
    .replace(/!?\[([^\]\n]*)\]\(([^)\s]+)[^)]*\)/g, "$1")
    .replace(/\*\*|__|~~|`/g, "")
    .trim();
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map(plainCell);
}

const width = (s: string) => [...s].length;

function tableBlock(rows: string[]): string {
  const cells = rows.map(splitRow);
  const columns = Math.max(...cells.map((r) => r.length));
  const widths = Array.from({ length: columns }, (_, c) => Math.max(1, ...cells.map((r) => width(r[c] ?? ""))));
  const render = (r: string[]) =>
    widths.map((w, c) => { const v = r[c] ?? ""; return v + " ".repeat(w - width(v)); }).join(" | ").trimEnd();
  const lines = [render(cells[0]!), widths.map((w) => "-".repeat(w)).join("-|-"), ...cells.slice(1).map(render)];
  return `<pre>${escape(lines.join("\n"))}</pre>`;
}

/** True when every tag in `html` is closed in the order it was opened. */
function isBalanced(html: string): boolean {
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
    if (!m[1]) stack.push(m[2]!);
    else if (stack.pop() !== m[2]) return false;
  }
  return stack.length === 0;
}

function wrap(text: string, re: RegExp, tag: string): string {
  return text.replace(re, (whole, inner: string) => (isBalanced(inner) ? `<${tag}>${inner}</${tag}>` : whole));
}

/**
 * One line of prose. Code spans, links and bare URLs are rendered first and parked behind
 * placeholders, so the emphasis rules below cannot reach into them (an `_` in a URL is not an
 * italic marker). Everything else is escaped before a single tag is added.
 */
function formatInline(line: string): string {
  const slots: string[] = [];
  const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;

  let s = line.replace(/`([^`\n]+)`/g, (_m, code: string) => hold(`<code>${escape(code)}</code>`));
  s = s.replace(/!?\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, label: string, url: string) => {
    const text = label.replace(/\*\*|__|~~/g, "").trim();
    return hold(text === url || !text ? escape(url) : `${escape(text)} (${escape(url)})`);
  });
  s = s.replace(/\bhttps?:\/\/[^\s<>()\u0000]*[^\s<>().,;:!?'"\u0000]/g, (url) => hold(escape(url)));

  s = escape(s);
  s = wrap(s, /\*\*(?=\S)([^\n]*?\S)\*\*/g, "b");
  s = wrap(s, /(?<!\w)__(?=\S)([^\n]*?\S)__(?!\w)/g, "b");
  s = wrap(s, /~~(?=\S)([^\n]*?\S)~~/g, "s");
  s = wrap(s, /(?<![*\w])\*(?=[^\s*])([^\n*]*?[^\s*])\*(?![*\w])/g, "i");
  s = wrap(s, /(?<!\w)_(?=[^\s_])([^\n_]*?[^\s_])_(?!\w)/g, "i");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => slots[Number(n)]!);
}

interface OpenTag { name: string; open: string }

const closersOf = (stack: readonly OpenTag[]) => stack.map((t) => `</${t.name}>`).reverse().join("");
const openersOf = (stack: readonly OpenTag[]) => stack.map((t) => t.open).join("");

function nextStack(stack: OpenTag[], token: string): OpenTag[] {
  if (token[0] !== "<") return stack;
  if (token[1] === "/") {
    const name = token.slice(2, -1).trim().toLowerCase();
    const at = stack.map((t) => t.name).lastIndexOf(name);
    return at === -1 ? stack : stack.slice(0, at);
  }
  const name = /^<([a-zA-Z][\w-]*)/.exec(token)?.[1]?.toLowerCase();
  return name ? [...stack, { name, open: token }] : stack;
}

/**
 * Cut HTML into messages of at most `max` characters (Telegram counts the text after parsing,
 * so measuring the HTML is never short). A cut never lands inside a tag, an entity or a
 * surrogate pair; it prefers a line break, then a space, past the first 30% of the message.
 * Tags open at the cut are closed at the end of one message and opened again at the start of
 * the next, so each message is valid on its own. Messages with no visible text are dropped.
 */
export function splitTelegramHtml(html: string, max = TELEGRAM_MESSAGE_MAX): string[] {
  const chunks: string[] = [];
  const push = (chunk: string) => { if (stripTelegramHtml(chunk).trim()) chunks.push(chunk); };
  if (html.length <= max) {
    push(html);
    return chunks;
  }

  let stack: OpenTag[] = [];
  let cur = "";
  let bodyStart = 0;
  let lastLine: { pos: number; stack: OpenTag[] } | null = null;
  let lastSpace: { pos: number; stack: OpenTag[] } | null = null;

  for (const [token] of html.matchAll(/<[^>]*>|&#?\w+;|[\s\S]/gu)) {
    const after = nextStack(stack, token);
    while (cur.length > bodyStart && cur.length + token.length + closersOf(after).length > max) {
      const minPos = bodyStart + Math.floor(max * 0.3);
      const cut = lastLine && lastLine.pos >= minPos ? lastLine : lastSpace && lastSpace.pos >= minPos ? lastSpace : null;
      if (cut) {
        push(cur.slice(0, cut.pos) + closersOf(cut.stack));
        const reopen = openersOf(cut.stack);
        cur = reopen + cur.slice(cut.pos);
        bodyStart = reopen.length;
      } else {
        push(cur + closersOf(stack));
        cur = openersOf(stack);
        bodyStart = cur.length;
      }
      lastLine = lastSpace = null;
    }
    cur += token;
    stack = after;
    if (token === "\n") lastLine = { pos: cur.length, stack };
    else if (token === " ") lastSpace = { pos: cur.length, stack };
  }
  push(cur + closersOf(stack));
  return chunks;
}

/**
 * Telegram HTML as plain text: what is resent when Telegram refuses the HTML. A link keeps its
 * address, so nothing the message pointed at is lost.
 */
export function stripTelegramHtml(html: string): string {
  return html
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) =>
      text === href ? text : `${text} (${href})`)
    // Only what looks like a tag: the HTML being stripped is often HTML Telegram refused over a
    // stray `<`, and that `<` is text the person should still see.
    .replace(/<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

/**
 * Secrets taken out of text bound for Telegram — the same rules the Logs window applies, minus
 * the switches about home paths, emails and chat ids, which are the person's own and not secret.
 */
export function redactForTelegram(text: string): string {
  return redactLogText(text, { home: false, email: false, chats: false });
}
