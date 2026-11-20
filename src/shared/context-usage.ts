/**
 * What fills a chat's context window, as the chat footer's context meter shows it: the CLI's
 * `get_context_usage` answer (Claude's `/context`) reduced to the rows a person reads.
 */

export type ContextRowKind = "used" | "free" | "buffer";

export interface ContextUsageRow {
  /** Stable id when the CLI sends one (`messages`, `system_tools`…); otherwise the name. */
  id: string;
  name: string;
  tokens: number;
  kind: ContextRowKind;
}

export interface ContextUsageView {
  model: string;
  percentage: number;
  totalTokens: number;
  maxTokens: number;
  /** In-window rows, largest first; out-of-window (deferred) tool schemas are left out. */
  rows: ContextUsageRow[];
}

/** The part of the SDK's `SDKControlGetContextUsageResponse` read here. */
export interface ContextUsageAnswer {
  categories: { id?: string; name: string; tokens: number; kind?: string; isDeferred?: boolean }[];
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  model: string;
}

const KINDS = new Set<ContextRowKind>(["used", "free", "buffer"]);

export function toContextUsageView(a: ContextUsageAnswer): ContextUsageView {
  const rows: ContextUsageRow[] = [];
  for (const c of a.categories ?? []) {
    if (c.isDeferred || c.kind === "deferred") continue;
    const kind: ContextRowKind = KINDS.has(c.kind as ContextRowKind) ? (c.kind as ContextRowKind) : c.id === "free_space" ? "free" : "used";
    if (!(c.tokens > 0)) continue;
    rows.push({ id: c.id ?? c.name, name: c.name, tokens: Math.round(c.tokens), kind });
  }
  // Used rows first, largest first; the buffer and the free space close the list.
  const order: Record<ContextRowKind, number> = { used: 0, buffer: 1, free: 2 };
  rows.sort((x, y) => order[x.kind] - order[y.kind] || y.tokens - x.tokens);
  return {
    model: a.model,
    percentage: Math.max(0, Math.min(100, Math.round(a.percentage))),
    totalTokens: Math.round(a.totalTokens),
    maxTokens: Math.round(a.maxTokens),
    rows,
  };
}

/** "12.3k", "1.2M", "850". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}
