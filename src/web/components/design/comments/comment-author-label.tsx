import { cn } from "@/lib/utils";
import type { OwnerViewAuthor } from "../../../../shared/design-comment-thread-types";

/**
 * Who wrote a comment or a reply, as the owner reads it: "You" for their own entries, the
 * reviewer's typed name otherwise, followed by the share link they came through. Both strings
 * come from outside the project and are only ever rendered as text.
 */

export const isReviewer = (a: OwnerViewAuthor): a is Extract<OwnerViewAuthor, { kind: "guest" }> => a.kind === "guest";

export function authorName(a: OwnerViewAuthor): string {
  return isReviewer(a) ? a.name : "You";
}

export function CommentAuthorLabel({ author, className }: { author: OwnerViewAuthor; className?: string }) {
  return (
    <span className={cn("min-w-0 truncate", className)}>
      <span className={isReviewer(author) ? "font-medium text-text" : undefined}>{authorName(author)}</span>
      {isReviewer(author) && <span className="text-text-subtle"> · via {author.linkLabel}</span>}
    </span>
  );
}
