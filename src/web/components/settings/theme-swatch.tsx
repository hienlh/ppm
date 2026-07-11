import { cn } from "@/lib/utils";

/** 3-color preview chip [bg, accent, accent2] used in the theme picker/grid. */
export function ThemeSwatch({
  swatch,
  className,
}: {
  swatch: [string, string, string];
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex overflow-hidden rounded-md border border-border shrink-0",
        className,
      )}
      aria-hidden
    >
      {swatch.map((color, i) => (
        <span key={i} className="w-3 h-6" style={{ background: color }} />
      ))}
    </span>
  );
}
