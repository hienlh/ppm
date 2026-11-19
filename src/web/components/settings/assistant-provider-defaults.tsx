import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ASSISTANT_EFFORTS, type AssistantEffort, type AssistantProviderDefaults } from "../../../shared/assistant-settings";
import { antigravityModelSupportsXhigh } from "@/components/chat/model-thinking-selector-helpers";
import type { ModelOption } from "../../../types/chat";

/** Select value standing for "nothing set here": the chat default applies. */
const CHAT_DEFAULT = "__chat__";

const EFFORT_LABELS: Record<AssistantEffort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra", max: "Max" };

/**
 * The model and effort new Assistant sessions on one provider start with. Unset falls back to
 * the chat default, which is what "Same as chats" says.
 */
export function AssistantProviderDefaultsRow({ provider, value, disabled, onChange }: {
  provider: { id: string; name: string };
  value: AssistantProviderDefaults;
  disabled?: boolean;
  onChange: (next: AssistantProviderDefaults) => void;
}) {
  const [models, setModels] = useState<ModelOption[]>([]);

  useEffect(() => {
    let active = true;
    api.get<ModelOption[]>(`/api/settings/ai/providers/${encodeURIComponent(provider.id)}/models`)
      .then((list) => { if (active) setModels(Array.isArray(list) ? list : []); })
      .catch(() => { if (active) setModels([]); });
    return () => { active = false; };
  }, [provider.id]);

  // A saved model the list does not hold (a renamed or retired one) still shows as chosen.
  const options = value.model && !models.some((m) => m.value === value.model)
    ? [...models, { value: value.model, label: value.model }]
    : models;
  const isAntigravity = provider.id === "antigravity";
  const effectiveAntigravityModel = isAntigravity
    ? models.find((m) => m.value === (value.model || models.find((x) => x.isDefault)?.value))
    : undefined;
  const allowAntigravityXhigh = effectiveAntigravityModel
    ? antigravityModelSupportsXhigh(effectiveAntigravityModel)
    : value.effort === "xhigh";
  const effortChoices = isAntigravity
    ? ASSISTANT_EFFORTS.filter((e) => e === "low" || e === "medium" || e === "high" || (e === "xhigh" && allowAntigravityXhigh))
    : ASSISTANT_EFFORTS;
  const effortValue = isAntigravity && effectiveAntigravityModel && !allowAntigravityXhigh
    && (value.effort === "xhigh" || value.effort === "max")
    ? "high"
    : (value.effort ?? CHAT_DEFAULT);
  const set = (patch: AssistantProviderDefaults) => {
    const next = { ...value, ...patch };
    if (isAntigravity && "model" in patch && (next.effort === "xhigh" || next.effort === "max")) {
      const target = models.find((m) => m.value === (next.model || models.find((x) => x.isDefault)?.value));
      if (target && !antigravityModelSupportsXhigh(target)) next.effort = "high";
    }
    onChange({ ...(next.model ? { model: next.model } : {}), ...(next.effort ? { effort: next.effort } : {}) });
  };

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-sm font-medium">{provider.name}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`asst-model-${provider.id}`} className="text-xs text-text-subtle">Model</Label>
          <Select value={value.model ?? CHAT_DEFAULT} disabled={disabled} onValueChange={(v) => set({ model: v === CHAT_DEFAULT ? undefined : v })}>
            <SelectTrigger id={`asst-model-${provider.id}`} className="h-11 w-full md:h-8"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-[300px]">
              <SelectItem value={CHAT_DEFAULT}>Same as chats</SelectItem>
              {options.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`asst-effort-${provider.id}`} className="text-xs text-text-subtle">Effort</Label>
          <Select value={effortValue} disabled={disabled}
            onValueChange={(v) => set({ effort: v === CHAT_DEFAULT ? undefined : (v as AssistantEffort) })}>
            <SelectTrigger id={`asst-effort-${provider.id}`} className="h-11 w-full md:h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={CHAT_DEFAULT}>Same as chats</SelectItem>
              {effortChoices.map((e) => <SelectItem key={e} value={e}>{EFFORT_LABELS[e]}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
