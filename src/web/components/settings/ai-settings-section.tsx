import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getAISettings, updateAISettings, type AISettings } from "@/lib/api-settings";

const MODEL_OPTIONS = [
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

const EFFORT_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

export function AISettingsSection() {
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Revision counter forces number inputs to re-render with fresh defaultValue after save
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    getAISettings().then(setSettings).catch((e) => setError(e.message));
  }, []);

  const providerName = settings?.default_provider ?? "claude";
  const config = settings?.providers[providerName];

  const handleSave = async (field: string, value: unknown) => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateAISettings({
        providers: { [providerName]: { [field]: value } },
      });
      setSettings(updated);
      setRevision((r) => r + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!settings) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-text-secondary">AI Provider</h3>
        <p className="text-sm text-text-subtle">
          {error ? `Error: ${error}` : "Loading..."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium text-text-secondary">AI Provider</h3>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="ai-model">Model</Label>
          <Select
            value={config?.model ?? "claude-sonnet-4-6"}
            onValueChange={(v) => handleSave("model", v)}
          >
            <SelectTrigger id="ai-model" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODEL_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ai-effort">Effort</Label>
          <Select
            value={config?.effort ?? "high"}
            onValueChange={(v) => handleSave("effort", v)}
          >
            <SelectTrigger id="ai-effort" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EFFORT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ai-max-turns">Max Turns (1-500)</Label>
          <Input
            key={`turns-${revision}`}
            id="ai-max-turns"
            type="number"
            min={1}
            max={500}
            defaultValue={config?.max_turns ?? 100}
            onBlur={(e) => {
              const val = parseInt(e.target.value);
              if (!isNaN(val)) handleSave("max_turns", val);
            }}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ai-budget">Max Budget (USD)</Label>
          <Input
            key={`budget-${revision}`}
            id="ai-budget"
            type="number"
            step={0.1}
            min={0.01}
            max={50}
            defaultValue={config?.max_budget_usd ?? ""}
            placeholder="No limit"
            onBlur={(e) => {
              const val = parseFloat(e.target.value);
              handleSave("max_budget_usd", isNaN(val) ? undefined : val);
            }}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ai-thinking">Thinking Budget (tokens)</Label>
          <Input
            key={`thinking-${revision}`}
            id="ai-thinking"
            type="number"
            min={0}
            defaultValue={config?.thinking_budget_tokens ?? ""}
            placeholder="Disabled"
            onBlur={(e) => {
              const val = parseInt(e.target.value);
              handleSave("thinking_budget_tokens", isNaN(val) ? undefined : val);
            }}
          />
        </div>
      </div>

      {saving && <p className="text-xs text-text-subtle">Saving...</p>}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
