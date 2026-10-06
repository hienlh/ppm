/**
 * Connection type as four logo tiles — PPM's one departure from DBGate's form, which has a dropdown.
 * A radio group: arrow keys move the choice, and a saved connection shows its type locked.
 */
import { useRef } from "react";
import { CheckCircle2 } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { DbEngineIcon } from "@/lib/file-icons";
import { DEFAULT_PORT } from "../../../../shared/db-connection-url";
import { DB_TYPES, DB_TYPE_LABELS, type DbType } from "../../../../shared/db-types";

const TAGLINE: Record<DbType, string> = {
  postgres: `Server · port ${DEFAULT_PORT.postgres}`,
  mysql: `Server · port ${DEFAULT_PORT.mysql}`,
  mariadb: `Server · port ${DEFAULT_PORT.mariadb}`,
  sqlite: "A file, no server",
};

export function EngineTiles({ value, locked, onPick, labelId }: {
  value: DbType;
  locked: boolean;
  onPick: (type: DbType) => void;
  labelId: string;
}) {
  const refs = useRef<Partial<Record<DbType, HTMLButtonElement | null>>>({});

  const move = (e: React.KeyboardEvent, from: DbType) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step || locked) return;
    e.preventDefault();
    const next = DB_TYPES[(DB_TYPES.indexOf(from) + step + DB_TYPES.length) % DB_TYPES.length]!;
    onPick(next);
    refs.current[next]?.focus();
  };

  return (
    <div role="radiogroup" aria-labelledby={labelId} className="grid grid-cols-2 gap-2 @[700px]:grid-cols-4">
      {DB_TYPES.map((type) => {
        const checked = type === value;
        return (
          <button
            key={type}
            ref={(el) => { refs.current[type] = el; }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={locked || undefined}
            tabIndex={checked ? 0 : -1}
            data-engine={type}
            onClick={() => { if (!locked) onPick(type); }}
            onKeyDown={(e) => move(e, type)}
            className={cn(
              "flex min-h-14 md:min-h-12 items-center gap-2 md:gap-2.5 rounded-lg border px-2.5 md:px-3 py-2 text-left transition-colors",
              checked
                ? "border-primary bg-accent-wash shadow-[inset_0_0_0_1px_var(--color-primary)]"
                : "border-border bg-surface",
              locked ? "cursor-default" : "can-hover:hover:border-primary/60",
              locked && !checked && "opacity-45",
            )}
          >
            <DbEngineIcon type={type} className="size-[26px]" />
            <span className="min-w-0 flex-1">
              <b className="block text-[13.5px] md:text-[12.5px] font-semibold text-text-primary">{DB_TYPE_LABELS[type]}</b>
              <small className="block truncate text-[11.5px] md:text-[11px] text-text-subtle">{TAGLINE[type]}</small>
            </span>
            <CheckCircle2 className={cn("hidden md:block size-3.5 shrink-0 text-primary", !checked && "invisible")} />
          </button>
        );
      })}
    </div>
  );
}
