/**
 * Renders an FTS5 snippet that contains literal `<mark>…</mark>` delimiters.
 * XSS-safe: parses only the exact mark delimiters into React nodes and renders
 * everything else as plain text (React escapes it) — never dangerouslySetInnerHTML.
 */
export function parseSnippet(snippet: string): { text: string; mark: boolean }[] {
  const parts: { text: string; mark: boolean }[] = [];
  const re = /<mark>([\s\S]*?)<\/mark>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet)) !== null) {
    if (m.index > last) parts.push({ text: snippet.slice(last, m.index), mark: false });
    parts.push({ text: m[1] ?? "", mark: true });
    last = re.lastIndex;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), mark: false });
  return parts;
}

export function SearchSnippet({ snippet, className }: { snippet: string; className?: string }) {
  return (
    <span className={className}>
      {parseSnippet(snippet).map((p, i) =>
        p.mark
          ? <mark key={i} className="bg-warning/30 text-foreground rounded-sm px-0.5">{p.text}</mark>
          : <span key={i}>{p.text}</span>,
      )}
    </span>
  );
}
