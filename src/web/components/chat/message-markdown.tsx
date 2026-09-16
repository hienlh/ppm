/**
 * The transcript's markdown, and the one reason it is fetched the way it is.
 *
 * The chunk fetch is kicked off at **module load**, not at first render: a
 * Suspense skeleton that resolves after the list has mounted grows each message
 * and shoves the bottom of the transcript out of view on a fresh load. Keeping
 * this module on `message-list.tsx`'s static import path is what preserves that
 * — reach it through `lazy()` and the fetch moves back to first render.
 */
import { lazy, Suspense } from "react";
import { RenderErrorBoundary } from "@/components/shared/markdown-error-boundary";

export const markdownRendererImport = import("@/components/shared/markdown-renderer");
const MarkdownRenderer = lazy(() =>
  markdownRendererImport.then((m) => ({ default: m.MarkdownRenderer }))
);
/** Strip SDK teammate-message XML tags from text — team popover shows these */
const TEAMMATE_MSG_RE = /<teammate-message[^>]*>[\s\S]*?<\/teammate-message>/g;
function stripTeammateMessages(text: string): string {
  return text.replace(TEAMMATE_MSG_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Wrapper: delegates to shared MarkdownRenderer with code actions enabled */
export function MarkdownContent({ content, projectName, isStreaming }: { content: string; projectName?: string; isStreaming?: boolean }) {
  const cleaned = stripTeammateMessages(content);
  if (!cleaned) return null;
  return (
    <RenderErrorBoundary fallbackContent={cleaned}>
      <Suspense fallback={<div className="animate-pulse h-4 bg-muted rounded" />}>
        <MarkdownRenderer content={cleaned} projectName={projectName} codeActions isStreaming={isStreaming} />
      </Suspense>
    </RenderErrorBoundary>
  );
}