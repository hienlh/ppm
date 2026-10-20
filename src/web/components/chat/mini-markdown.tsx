import { lazy, Suspense, useContext } from "react";
import { AssistantContentContext } from "@/components/shared/markdown-context";

const MarkdownRenderer = lazy(() =>
  import("@/components/shared/markdown-renderer").then((m) => ({ default: m.MarkdownRenderer }))
);

/**
 * Compact, height-capped markdown for tool cards. Lazy so the markdown bundle only
 * loads once a card is actually expanded.
 *
 * It is given no project name, so whether it is PPM Assistant content comes only from the
 * surrounding `AssistantContentContext` — the Assistant's chat, or an agent session window
 * opened from it. Passed on explicitly so that marking cannot be lost on the way down.
 */
export function MiniMarkdown({ content, maxHeight = "max-h-48" }: { content: string; maxHeight?: string }) {
  const assistantContent = useContext(AssistantContentContext);
  return (
    <Suspense fallback={<div className="animate-pulse h-4 bg-muted rounded" />}>
      <MarkdownRenderer content={content} assistantContent={assistantContent} className={`text-text-secondary overflow-auto ${maxHeight}`} />
    </Suspense>
  );
}
