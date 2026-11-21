import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MAX_IDLE_CLI_RELEASE_MINUTES, MAX_MEMORY_FREE_GB, memoryGuardSettings, type MemoryGuardConfig,
} from "../../../shared/memory-guard";

/**
 * Settings → AI Provider: the memory guard's three numbers (`src/shared/memory-guard.ts`). Saved on
 * blur like the leftover-process field above them; an out-of-range number is brought into range,
 * and a cleared field shows the saved value again rather than looking saved.
 */
export function MemoryGuardSettingsFields({
  settings, revision, compact, labelSize, fieldGap, onSave,
}: {
  settings: MemoryGuardConfig;
  revision: number;
  compact?: boolean;
  labelSize: string;
  fieldGap: string;
  onSave: (patch: MemoryGuardConfig) => void;
}) {
  const current = memoryGuardSettings(settings);
  const note = `${compact ? "text-[9px]" : "text-[11px]"} text-muted-foreground`;
  const inputClass = compact ? "h-7 text-[11px]" : undefined;

  const field = (
    id: string,
    label: string,
    value: number,
    max: number,
    step: number,
    description: string,
    save: (n: number) => void,
  ) => (
    <div className={fieldGap}>
      <Label htmlFor={id} className={compact ? labelSize : undefined}>{label}</Label>
      <Input
        key={`${id}-${revision}`}
        id={id}
        type="number"
        min={0}
        max={max}
        step={step}
        defaultValue={value}
        aria-describedby={`${id}-description`}
        className={inputClass}
        onBlur={(e) => {
          const raw = Number(e.target.value);
          const parsed = e.target.value.trim() === "" || !Number.isFinite(raw) ? null : Math.round(raw / step) * step;
          const n = parsed === null ? null : Math.min(max, Math.max(0, parsed));
          e.target.value = String(n ?? value);
          if (n !== null && n !== value) save(n);
        }}
      />
      <p id={`${id}-description`} className={note}>{description}</p>
    </div>
  );

  return (
    <>
      {field(
        "ai-memory-warn", "Warn when free memory falls under (GB, 0 = off)", current.warnFreeGB, MAX_MEMORY_FREE_GB, 0.5,
        "Free commit is what Windows can still hand out (on Linux, available memory plus free swap). Under this, you get a Low memory notification naming the chat whose processes are growing fastest.",
        (n) => onSave({ memory_warn_free_gb: n }),
      )}
      {field(
        "ai-memory-block", "Hold heavy commands under (GB, 0 = off)", current.blockFreeGB, MAX_MEMORY_FREE_GB, 0.5,
        "Under this, test runs, type checks, builds and e2e runs a chat starts are refused with a note to wait, quiet chats' subprocesses are released, and PPM waits for memory before restarting itself.",
        (n) => onSave({ memory_block_free_gb: n }),
      )}
      {field(
        "ai-idle-cli-release", "Release a quiet chat's subprocess after (minutes, 0 = never)", current.idleCliReleaseMinutes, MAX_IDLE_CLI_RELEASE_MINUTES, 1,
        "Even with its tab open. The subprocess and its MCP servers take about 1 GB; the chat's next message starts a new one, which takes a few seconds.",
        (n) => onSave({ idle_cli_release_minutes: n }),
      )}
    </>
  );
}
