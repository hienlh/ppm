import { cn } from "@/lib/utils";
import { getFeatureBadge, type FeatureBadgeId } from "@/lib/feature-badges";

/**
 * Renders the "new" / "beta" pill for a feature registered in
 * `src/web/lib/feature-badges.ts`; renders nothing for untagged features, so
 * call sites can pass an optional id without branching.
 *
 * - `corner`: absolutely positioned over an icon button (nav rail, bottom bar).
 * - `inline`: flows after a text label (sheet rows, panel headers).
 */
export function FeatureBadge({
  id,
  variant = "inline",
  className,
}: {
  id: FeatureBadgeId | undefined;
  variant?: "corner" | "inline";
  className?: string;
}) {
  const kind = getFeatureBadge(id);
  if (!kind) return null;
  // "new" uses the success tone so it reads differently from the caution-toned beta pill.
  const tone = kind === "new" ? "bg-success/15 text-success" : "bg-accent-wash text-primary";
  return (
    <span
      aria-label={kind}
      className={cn(
        "rounded-full font-bold uppercase tracking-wide",
        variant === "corner"
          ? "absolute -top-0.5 -right-0.5 px-1 text-[7px] leading-[1.4] shadow-sm"
          : "px-1.5 py-px text-[9px] font-semibold leading-[1.4]",
        tone,
        className,
      )}
    >
      {kind}
    </span>
  );
}
