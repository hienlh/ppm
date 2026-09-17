import { useState, type FormEvent } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AIProviderSettings } from "@/lib/api-settings";

type ContextSettings = Pick<AIProviderSettings, "model_context_window" | "model_auto_compact_token_limit">;

interface Props {
  config?: ContextSettings;
  compact?: boolean;
  saving: boolean;
  onSave: (settings: ContextSettings) => Promise<boolean>;
}

const WINDOW_PRESETS = [128000, 272000, 400000, 512000, 872000, 1000000];
const COMPACT_PRESETS = [100000, 200000, 230000, 350000, 450000, 750000, 900000];

function TokenLimitSelect({ id, label, value, presets, disabled, compact, onChange }: {
  id: string; label: string; value: string; presets: number[]; disabled: boolean;
  compact?: boolean; onChange: (value: string) => void;
}) {
  const [custom, setCustom] = useState(Boolean(value) && !presets.includes(Number(value)));
  const size = compact ? "text-[11px]" : "text-sm";
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className={size}>{label}</Label>
      <select id={id} value={custom ? "custom" : value || "default"} disabled={disabled}
        aria-describedby="codex-context-help"
        className={`w-full min-h-11 sm:min-h-0 rounded-md border border-input bg-background px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${compact ? "h-7" : "h-9"} ${size}`}
        onChange={(e) => {
          const next = e.target.value;
          setCustom(next === "custom");
          if (next !== "custom") onChange(next === "default" ? "" : next);
        }}>
        <option value="default">Codex default</option>
        {presets.map((tokens) => <option key={tokens} value={String(tokens)}>
          {tokens === 1000000 ? "1M" : `${tokens / 1000}K`} tokens
        </option>)}
        <option value="custom">Custom...</option>
      </select>
      {custom && <Input id={`${id}-custom`} aria-label={`Custom ${label.toLowerCase()}`}
        type="number" min={1} step={1} required value={value} disabled={disabled}
        placeholder="Enter tokens" aria-describedby="codex-context-help"
        className={`min-h-11 sm:min-h-0 ${compact ? "h-7 text-[11px]" : ""}`}
        onChange={(e) => onChange(e.target.value)} />}
    </div>
  );
}

export function CodexContextSettings({ config, compact, saving, onSave }: Props) {
  const [windowTokens, setWindowTokens] = useState(String(config?.model_context_window ?? ""));
  const [compactTokens, setCompactTokens] = useState(String(config?.model_auto_compact_token_limit ?? ""));
  const [error, setError] = useState<string | null>(null);
  const textSize = compact ? "text-[11px]" : "text-sm";
  const helpSize = compact ? "text-[9px]" : "text-[11px]";

  async function save(event: FormEvent) {
    event.preventDefault();
    const windowValue = windowTokens.trim() ? Number(windowTokens) : null;
    const compactValue = compactTokens.trim() ? Number(compactTokens) : null;
    if ([windowValue, compactValue].some((v) => v !== null && (!Number.isSafeInteger(v) || v <= 0))) {
      setError("Enter positive whole numbers of tokens, or leave blank for Codex defaults.");
      return;
    }
    if (windowValue !== null && compactValue !== null && compactValue > windowValue) {
      setError("Auto-compact threshold must not exceed the context window.");
      return;
    }
    setError(null);
    await onSave({ model_context_window: windowValue, model_auto_compact_token_limit: compactValue });
  }

  return (
    <form onSubmit={save} className="space-y-2 rounded-md border border-border p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TokenLimitSelect id="codex-context-window" label="Context window (tokens)"
          value={windowTokens} presets={WINDOW_PRESETS} disabled={saving} compact={compact}
          onChange={(value) => { setWindowTokens(value); setError(null); }} />
        <TokenLimitSelect id="codex-compact-threshold" label="Auto-compact threshold (tokens)"
          value={compactTokens} presets={COMPACT_PRESETS} disabled={saving} compact={compact}
          onChange={(value) => { setCompactTokens(value); setError(null); }} />
      </div>
      <p id="codex-context-help" className={`${helpSize} text-muted-foreground`}>
        Choose Codex default to use Codex configuration and model defaults, or Custom to enter a value.
        Presets are shortcuts, not a list of limits supported by your model;
        increasing these values does not unlock a larger context window.
        Applies to new sessions and sessions resumed after a PPM restart.
      </p>
      {error && <p role="alert" className={`${textSize} text-error`}>{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <a href="https://learn.chatgpt.com/docs/config-file/config-reference" target="_blank" rel="noreferrer"
          className={`${helpSize} text-primary underline`}>Codex context documentation</a>
        <button type="submit" disabled={saving}
          className={`min-h-11 sm:min-h-0 rounded-md border border-border px-3 py-1.5 hover:bg-surface-elevated disabled:opacity-50 ${textSize}`}>
          {saving ? "Saving..." : "Save context settings"}
        </button>
      </div>
    </form>
  );
}
