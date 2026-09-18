/**
 * Ellipsize from the start, so the end of a string — the part that differs —
 * survives.
 *
 * A right-to-left box cuts at its left edge, and `<bdi>` keeps the name itself
 * reading left to right; the isolate is load-bearing rather than tidy, because
 * outside one a leading `.` takes the paragraph's direction and `.gitignore`
 * renders as `gitignore.`. Used for file paths, where the filename is the
 * distinguishing part, and for branch names, where a repository's branches all
 * begin `fix/NX-`.
 */
export function StartEllipsis({ children }: { children: string }) {
  return (
    <span dir="rtl" className="truncate text-left min-w-0 flex-1">
      <bdi>{children}</bdi>
    </span>
  );
}
