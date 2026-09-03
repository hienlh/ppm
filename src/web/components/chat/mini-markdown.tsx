import { lazy, Suspense } from "react";

const MarkdownRenderer = lazy(() =>
  import("@/components/shared/markdown-renderer").then((m) => ({ default: m.MarkdownRenderer }))
);

/**
 * Compact, height-capped markdown for tool cards. Lazy so the markdown bundle only
 * loads once a card is actually expanded.
 */
export function MiniMarkdown({ content, maxHeight = "max-h-48" }: { content: string; maxHeight?: string }) {
  return (
    <Suspense fallback={<div className="animate-pulse h-4 bg-muted rounded" />}>
      <MarkdownRenderer content={content} className={`text-text-secondary overflow-auto ${maxHeight}`} />
    </Suspense>
  );
}
