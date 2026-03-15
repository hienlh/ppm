---
phase: 6
title: "Frontend Settings UI"
status: complete
effort: 2h
depends_on: [3]
---

# Phase 6: Frontend Settings UI

## Overview
Add AI settings section to the existing `SettingsTab`. Fetches config from API on mount, PUTs changes back. Uses existing shadcn/ui components.

## Context
- Current `settings-tab.tsx` (57 lines) only has theme toggle
- Available UI components: `Button`, `Input`, `Separator`, `Dialog`, `Tabs`, `Dropdown`, `Tooltip`
- Missing components that may need adding via shadcn: `Select`, `Slider`, `Label`
- Settings store currently only handles theme (localStorage). AI settings hit the API directly — no Zustand store needed (YAGNI: just useState + fetch).

## Files to Create
- `src/web/components/settings/ai-settings-section.tsx` — AI config form component
- `src/web/lib/api-settings.ts` — API client functions for settings

## Files to Edit
- `src/web/components/settings/settings-tab.tsx` — import and render AI section

## Dependencies (shadcn components)
Check if `Select` and `Label` exist. If not, add them:
```bash
bunx shadcn@latest add select label
```
`Slider` not needed — use number `Input` for simplicity (KISS).

## Implementation Steps

### 1. Create API client: `src/web/lib/api-settings.ts`

Uses existing `api` singleton from `api-client.ts` which auto-unwraps `{ok, data}` envelope and handles auth.

```typescript
import { api } from "./api-client";

export interface AISettings {
  default_provider: string;
  providers: Record<string, {
    type: string;
    api_key_env?: string;
    model?: string;
    effort?: string;
    max_turns?: number;
    max_budget_usd?: number;
    thinking_budget_tokens?: number;
  }>;
}

export function getAISettings(): Promise<AISettings> {
  return api.get<AISettings>("/api/settings/ai");
}

export function updateAISettings(settings: Partial<AISettings>): Promise<AISettings> {
  return api.put<AISettings>("/api/settings/ai", settings);
}
```

### 2. Create `src/web/components/settings/ai-settings-section.tsx`

Component structure (~150 lines max):

```tsx
export function AISettingsSection() {
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch on mount
  useEffect(() => { getAISettings().then(setSettings).catch(...); }, []);

  // Derive current provider config (the default_provider's config)
  const providerName = settings?.default_provider ?? "claude";
  const config = settings?.providers[providerName];

  // Save handler: debounced or on-blur
  const handleSave = async (field: string, value: unknown) => {
    setSaving(true);
    try {
      const updated = await updateAISettings({
        providers: { [providerName]: { [field]: value } }
      });
      setSettings(updated);
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  if (!settings) return <div>Loading...</div>;

  return (
    <div className="space-y-4">
      <h3>AI Provider</h3>

      {/* Model selector */}
      <Select value={config?.model} onValueChange={(v) => handleSave("model", v)}>
        <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
        <option value="claude-opus-4-6">Claude Opus 4.6</option>
        <option value="claude-haiku-4-5">Claude Haiku 4.5</option>
      </Select>

      {/* Effort */}
      <Select value={config?.effort} onValueChange={(v) => handleSave("effort", v)}>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
        <option value="max">Max</option>
      </Select>

      {/* Max Turns */}
      <Input type="number" min={1} max={500}
        value={config?.max_turns ?? 100}
        onBlur={(e) => handleSave("max_turns", parseInt(e.target.value))} />

      {/* Max Budget */}
      <Input type="number" step={0.1} min={0.01} max={50}
        value={config?.max_budget_usd ?? ""}
        placeholder="No limit"
        onBlur={(e) => handleSave("max_budget_usd", parseFloat(e.target.value) || undefined)} />

      {/* Thinking Budget */}
      <Input type="number" min={0}
        value={config?.thinking_budget_tokens ?? ""}
        placeholder="Disabled"
        onBlur={(e) => handleSave("thinking_budget_tokens", parseInt(e.target.value) || undefined)} />

      {saving && <span className="text-xs text-text-subtle">Saving...</span>}
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  );
}
```

Design notes:
- Save on blur (not on every keystroke) to avoid spamming API
- Select components for enum fields (model, effort)
- Number inputs for numeric fields
- Empty/placeholder values mean "not set" (uses default)
- Show saving/error state inline

### 3. Update `settings-tab.tsx`

Add AI section between theme and about:

```tsx
import { AISettingsSection } from "./ai-settings-section";

// In the JSX, after theme section and before about:
<Separator />
<AISettingsSection />
<Separator />
```

## UI Layout Sketch

```
Settings
---------
Theme: [Light] [Dark] [System]
---------
AI Provider
  Model:     [Claude Sonnet 4.6 v]
  Effort:    [High v]
  Max Turns: [100    ]
  Budget:    [       ] (no limit)
  Thinking:  [       ] (disabled)
                         Saving...
---------
About
  PPM -- Personal Project Manager
```

## Todo
- [x] Check if Select and Label shadcn components exist; add if needed
- [x] Find existing API fetch pattern and match it
- [x] Create `src/web/lib/api-settings.ts`
- [x] Create `src/web/components/settings/ai-settings-section.tsx`
- [x] Update `settings-tab.tsx` to include AI section
- [x] Test: change model in UI, verify yaml updates on disk
- [x] Test: refresh page, verify settings load from API

## Success Criteria
- AI settings section visible in Settings tab
- Changing a value saves to yaml via API
- Page refresh loads saved values
- Invalid values show error from API validation
- Each file stays under 200 lines
