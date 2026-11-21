/**
 * The palette's notice that the server stopped listing the project at its entry cap: files past
 * it are in neither the list nor search, and nothing else on screen says so — a search for one of
 * them simply comes back empty. Points at the place to fix it, the project's file filters.
 */
import { TriangleAlert } from "@/lib/icons";
import { openSettings } from "@/components/settings/open-settings";

export function CommandPaletteTruncatedNotice({ count, onOpenSettings }: { count: number; onOpenSettings?: () => void }) {
  return (
    <div role="status" className="flex items-start gap-2 border-b border-border/50 bg-amber-500/10 px-3 py-2">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
      <p className="min-w-0 flex-1 text-[11px] leading-snug text-text-secondary">
        File list cut at {count.toLocaleString()} entries — some files will not be found here.{" "}
        <button
          type="button"
          onClick={() => {
            onOpenSettings?.();
            openSettings("files");
          }}
          className="inline text-primary underline-offset-2 hover:underline"
        >
          Exclude large folders in this project&apos;s File Filters
        </button>
      </p>
    </div>
  );
}
