import { cn } from "@/lib/utils";
import {
  SHARE_EXPIRY_PRESETS, maxCustomDate, minCustomDate, type ShareExpiryChoice,
} from "@/lib/design/design-share-expiry";

/**
 * Expiry presets as one row of radio chips, plus the native date input for Custom (the end of
 * that day, local time). Used by the new-link form and by Change expiry.
 */
export function ShareExpiryPicker({ value, onChange, error, idPrefix }: {
  value: ShareExpiryChoice;
  onChange: (next: ShareExpiryChoice) => void;
  error?: string | null;
  idPrefix: string;
}) {
  const now = Date.now();
  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label="Expires after" className="flex flex-wrap gap-2">
        {SHARE_EXPIRY_PRESETS.map((p) => {
          const on = value.preset === p.id;
          return (
            <button key={p.id} type="button" role="radio" aria-checked={on}
              onClick={() => onChange({ ...value, preset: p.id })}
              className={cn("min-h-11 rounded-md border px-3 text-sm md:min-h-8",
                on ? "border-primary bg-primary/10 text-foreground" : "border-border text-text-2 hover:bg-surface-elevated")}>
              {p.label}
            </button>
          );
        })}
      </div>
      {value.preset === "custom" && (
        <label htmlFor={`${idPrefix}-date`} className="flex flex-col gap-1 text-xs text-text-subtle">
          Open until the end of
          <input id={`${idPrefix}-date`} type="date" value={value.customDate}
            min={minCustomDate(now)} max={maxCustomDate(now)}
            onChange={(e) => onChange({ ...value, customDate: e.target.value })}
            className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary md:min-h-9" />
        </label>
      )}
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    </div>
  );
}
