/**
 * Syntax colours for the Review tab's code, from the same shiki highlighter (and theme) as the
 * chat's code blocks. Each block is tokenized as two pieces — the lines it had and the lines it
 * has — so a comment or a string that spans lines inside it is coloured as one; a block that
 * starts in the middle of one is not, which is the price of never tokenizing the whole file.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ThemedToken } from "shiki";
import { highlightToTokens, tokensSync } from "@/theme/adapters/shiki-adapter";

const THEME_EVENT = "ppm:shiki-theme-change";

/** The language to ask shiki for: the file's extension, which shiki takes as an alias for most. */
export function reviewLanguage(path: string): string | undefined {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1).toLowerCase();
  if (name === "dockerfile" || name.endsWith(".dockerfile")) return "docker";
  if (name === "makefile") return "make";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : undefined;
}

/** Each text's tokens, line by line: null for one not ready yet, which then renders plain. */
export function useTokenLines(texts: readonly string[], lang: string | undefined): (ThemedToken[][] | null)[] {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onTheme = () => setTick((t) => t + 1);
    window.addEventListener(THEME_EVENT, onTheme);
    return () => window.removeEventListener(THEME_EVENT, onTheme);
  }, []);
  const lines = useMemo(() => texts.map((t) => tokensSync(t, lang)), [...texts, lang, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const missing = lines.some((l) => l === null);
  useEffect(() => {
    if (!missing) return;
    let cancelled = false;
    // Loads the highlighter and the language; the tokens land in its cache for the next render.
    void Promise.all(texts.map((t) => highlightToTokens(t, lang).catch(() => null))).then(() => {
      if (!cancelled) setTick((t) => t + 1);
    });
    return () => { cancelled = true; };
  }, [missing, ...texts, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  return lines;
}

/** One line's code: its tokens, with `span` (the part that changed) marked by `spanClass`. */
export function CodeLine({ text, tokens, span, spanClass }: {
  text: string;
  tokens: ThemedToken[] | null | undefined;
  span: [number, number] | null;
  spanClass: string;
}) {
  // Tokens that do not add up to the line belong to other text: draw it plain rather than wrong.
  const pieces = tokens && tokens.reduce((n, t) => n + t.content.length, 0) === text.length ? tokens : [{ content: text } as ThemedToken];
  const out: ReactNode[] = [];
  let at = 0;
  pieces.forEach((t, i) => {
    const start = at;
    at += t.content.length;
    const style = t.color || t.fontStyle ? { color: t.color, fontStyle: t.fontStyle && t.fontStyle & 1 ? "italic" : undefined } : undefined;
    if (!span || at <= span[0] || start >= span[1]) {
      out.push(<span key={i} style={style}>{t.content}</span>);
      return;
    }
    const a = Math.max(span[0], start) - start;
    const b = Math.min(span[1], at) - start;
    if (a > 0) out.push(<span key={`${i}a`} style={style}>{t.content.slice(0, a)}</span>);
    out.push(<span key={`${i}b`} style={style} className={spanClass}>{t.content.slice(a, b)}</span>);
    if (b < t.content.length) out.push(<span key={`${i}c`} style={style}>{t.content.slice(b)}</span>);
  });
  return <>{out}</>;
}
