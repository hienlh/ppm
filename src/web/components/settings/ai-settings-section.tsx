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
import { Switch } from "@/components/ui/switch";
import { getAISettings, updateAISettings, type AISettings } from "@/lib/api-settings";
import { api } from "@/lib/api-client";
import { ProviderBadge } from "@/components/chat/provider-selector";
import type { ModelOption } from "../../../types/chat";

const EFFORT_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const PERMISSION_MODE_OPTIONS = [
  { value: "bypassPermissions", label: "Bypass permissions (default)" },
  { value: "default", label: "Ask before edits" },
  { value: "acceptEdits", label: "Edit automatically" },
  { value: "plan", label: "Plan mode" },
];

const PROVIDER_NAMES: Record<string, string> = {
  claude: "Claude",
  cursor: "Cursor",
  codex: "Codex",
  gemini: "Gemini",
};

export function AISettingsSection({ compact }: { compact?: boolean } = {}) {
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [activeTab, setActiveTab] = useState<string>("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    getAISettings().then((s) => {
      setSettings(s);
      setActiveTab(s.default_provider ?? "claude");
    }).catch((e) => setError(e.message));
  }, []);

  // Fetch models when active tab changes — uses global settings endpoint
  useEffect(() => {
    if (!activeTab) return;
    setModelsLoading(true);
    api.get<ModelOption[]>(`/api/settings/ai/providers/${activeTab}/models`)
      .then(setModels)
      .catch(() => setModels([]))
      .finally(() => setModelsLoading(false));
  }, [activeTab]);

  const providerTabs = settings
    ? Object.keys(settings.providers)
        .filter((k) => k !== "mock")
        .map((id) => ({ id, name: PROVIDER_NAMES[id] ?? id }))
    : [];

  const config = settings?.providers[activeTab];
  const isSdkProvider = config?.type === "agent-sdk" || (!config?.type && activeTab === "claude");

  const handleSave = async (field: string, value: unknown) => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateAISettings({
        providers: { [activeTab]: { [field]: value } },
      });
      setSettings(updated);
      setRevision((r) => r + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const labelSize = compact ? "text-[11px]" : "text-sm";
  const headingSize = compact ? "text-xs" : "text-sm";
  const gapSize = compact ? "space-y-2" : "space-y-4";
  const innerGap = compact ? "space-y-1.5" : "space-y-3";
  const fieldGap = compact ? "space-y-1" : "space-y-1.5";

  if (!settings) {
    return (
      <div className={innerGap}>
        <h3 className={`${headingSize} font-medium text-text-secondary`}>AI Settings</h3>
        <p className={`${labelSize} text-text-subtle`}>
          {error ? `Error: ${error}` : "Loading..."}
        </p>
      </div>
    );
  }

  // Model select options: use fetched models, with "auto" option for non-SDK providers
  const modelOptions = isSdkProvider
    ? models
    : [{ value: "__default__", label: "Auto (default)" }, ...models];

  return (
    <div className={gapSize}>
      <h3 className={`${headingSize} font-medium text-text-secondary`}>AI Settings</h3>

      {/* Provider tabs */}
      {providerTabs.length > 1 && (
        <div className="flex gap-0.5 border-b border-border/50 -mx-1 px-1">
          {providerTabs.map((p) => (
            <button
              key={p.id}
              onClick={() => setActiveTab(p.id)}
              className={`flex items-center gap-1 px-2 py-1 text-[11px] rounded-t transition-colors ${
                activeTab === p.id
                  ? "text-primary border-b-2 border-primary font-medium"
                  : "text-text-subtle hover:text-text-secondary"
              }`}
            >
              <ProviderBadge providerId={p.id} />
              <span className="capitalize">{p.name}</span>
            </button>
          ))}
        </div>
      )}

      <div className={innerGap}>
        {/* Model selector — dynamic, works for all providers */}
        {models.length > 0 && (
          <div className={fieldGap}>
            <Label htmlFor="ai-model" className={compact ? labelSize : undefined}>Model</Label>
            <Select
              value={isSdkProvider ? (config?.model ?? models[0]?.value) : (config?.model || "__default__")}
              onValueChange={(v) => handleSave("model", v === "__default__" ? undefined : v)}
              disabled={modelsLoading}
            >
              <SelectTrigger id="ai-model" className={`w-full ${compact ? "h-7 text-[11px]" : ""}`}>
                <SelectValue placeholder={modelsLoading ? "Loading models..." : "Select model"} />
              </SelectTrigger>
              <SelectContent className="max-h-[300px]">
                {modelOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* SDK-specific fields */}
        {isSdkProvider && (
          <>
            <div className={fieldGap}>
              <Label htmlFor="ai-base-url" className={compact ? labelSize : undefined}>Base URL</Label>
              <Input
                key={`baseurl-${activeTab}-${revision}`}
                id="ai-base-url"
                type="url"
                defaultValue={config?.base_url ?? ""}
                placeholder="https://api.anthropic.com (default)"
                className={compact ? "h-7 text-[11px]" : undefined}
                onBlur={(e) => {
                  const val = e.target.value.trim();
                  handleSave("base_url", val || undefined);
                }}
              />
            </div>

            <div className={fieldGap}>
              <Label htmlFor="ai-api-key" className={compact ? labelSize : undefined}>API Key / Token</Label>
              <Input
                key={`apikey-${activeTab}-${revision}`}
                id="ai-api-key"
                type="password"
                defaultValue={config?.api_key ?? ""}
                placeholder="sk-ant-... (optional, overrides accounts)"
                className={compact ? "h-7 text-[11px] font-mono" : "font-mono"}
                onBlur={(e) => {
                  const val = e.target.value.trim();
                  if (val.startsWith("••••")) return;
                  handleSave("api_key", val || undefined);
                }}
              />
              <p className={`${compact ? "text-[9px]" : "text-[11px]"} text-muted-foreground`}>
                Direct API key or OAuth token. Leave empty to use connected accounts.
              </p>
            </div>

            <div className={fieldGap}>
              <Label htmlFor="ai-effort" className={compact ? labelSize : undefined}>Effort</Label>
              <Select
                value={config?.effort ?? "high"}
                onValueChange={(v) => handleSave("effort", v)}
              >
                <SelectTrigger id="ai-effort" className={`w-full ${compact ? "h-7 text-[11px]" : ""}`}>
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

            <div className={fieldGap}>
              <Label htmlFor="ai-max-turns" className={compact ? labelSize : undefined}>Max Turns (1-500)</Label>
              <Input
                key={`turns-${activeTab}-${revision}`}
                id="ai-max-turns"
                type="number"
                min={1}
                max={500}
                defaultValue={config?.max_turns ?? 100}
                className={compact ? "h-7 text-[11px]" : undefined}
                onBlur={(e) => {
                  const val = parseInt(e.target.value);
                  if (!isNaN(val)) handleSave("max_turns", val);
                }}
              />
            </div>

            <div className={fieldGap}>
              <Label htmlFor="ai-budget" className={compact ? labelSize : undefined}>Max Budget (USD)</Label>
              <Input
                key={`budget-${activeTab}-${revision}`}
                id="ai-budget"
                type="number"
                step={0.1}
                min={0.01}
                max={50}
                defaultValue={config?.max_budget_usd ?? ""}
                placeholder="No limit"
                className={compact ? "h-7 text-[11px]" : undefined}
                onBlur={(e) => {
                  const val = parseFloat(e.target.value);
                  handleSave("max_budget_usd", isNaN(val) ? undefined : val);
                }}
              />
            </div>

            <div className={fieldGap}>
              <Label htmlFor="ai-thinking" className={compact ? labelSize : undefined}>Thinking Budget (tokens)</Label>
              <Input
                key={`thinking-${activeTab}-${revision}`}
                id="ai-thinking"
                type="number"
                min={0}
                defaultValue={config?.thinking_budget_tokens ?? ""}
                placeholder="Disabled"
                className={compact ? "h-7 text-[11px]" : undefined}
                onBlur={(e) => {
                  const val = parseInt(e.target.value);
                  handleSave("thinking_budget_tokens", isNaN(val) ? undefined : val);
                }}
              />
            </div>

            <div className="flex items-center justify-between gap-2">
              <div>
                <Label htmlFor="ai-agent-teams" className={compact ? labelSize : undefined}>Agent Teams</Label>
                <p className={`${compact ? "text-[9px]" : "text-[11px]"} text-muted-foreground`}>
                  Experimental. Enables multi-agent collaboration with shared tasks and messaging. Uses ~7x more tokens.
                </p>
              </div>
              <Switch
                id="ai-agent-teams"
                checked={config?.agent_teams ?? false}
                onCheckedChange={(v) => handleSave("agent_teams", v)}
              />
            </div>
          </>
        )}

        {/* Common fields: permission mode + system prompt (all providers) */}
        <div className={fieldGap}>
          <Label htmlFor="ai-permission-mode" className={compact ? labelSize : undefined}>Default Permission Mode</Label>
          <Select
            value={config?.permission_mode ?? "bypassPermissions"}
            onValueChange={(v) => handleSave("permission_mode", v)}
          >
            <SelectTrigger id="ai-permission-mode" className={`w-full ${compact ? "h-7 text-[11px]" : ""}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERMISSION_MODE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className={fieldGap}>
          <Label htmlFor="ai-system-prompt" className={compact ? labelSize : undefined}>Additional Instructions</Label>
          <textarea
            key={`sysprompt-${activeTab}-${revision}`}
            id="ai-system-prompt"
            rows={compact ? 3 : 4}
            defaultValue={config?.system_prompt ?? ""}
            placeholder={`Enter additional instructions for ${activeTab}...`}
            className={`w-full rounded-md border border-input bg-background px-3 py-2 ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${compact ? "text-[11px]" : "text-sm"}`}
            onBlur={(e) => {
              const val = e.target.value.trim();
              handleSave("system_prompt", val || undefined);
            }}
          />
        </div>
      </div>

      {saving && <p className="text-xs text-text-subtle">Saving...</p>}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
