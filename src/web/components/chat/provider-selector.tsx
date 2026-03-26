import { useState, useEffect } from "react";
import { api, projectUrl } from "@/lib/api-client";

interface ProviderInfo {
  id: string;
  name: string;
}

interface ProviderSelectorProps {
  value: string;
  onChange: (providerId: string) => void;
  projectName: string;
}

const PROVIDER_ICONS: Record<string, string> = {
  claude: "C",
  cursor: "▶",
  codex: "◆",
  gemini: "G",
};

/**
 * Provider selector dropdown — shows available AI providers.
 * Hidden when only 1 provider available.
 */
export function ProviderSelector({ value, onChange, projectName }: ProviderSelectorProps) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);

  useEffect(() => {
    if (!projectName) return;
    api.get<ProviderInfo[]>(`${projectUrl(projectName)}/chat/providers`)
      .then(setProviders)
      .catch(() => {});
  }, [projectName]);

  // Hide when only 1 provider
  if (providers.length <= 1) return null;

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="text-xs bg-surface border border-border rounded px-1.5 py-1 text-text-secondary hover:text-text-primary transition-colors cursor-pointer min-w-0"
      aria-label="Select AI provider"
    >
      {providers.map((p) => (
        <option key={p.id} value={p.id}>
          {PROVIDER_ICONS[p.id] || "?"} {p.name}
        </option>
      ))}
    </select>
  );
}

/** Small provider badge for session lists */
export function ProviderBadge({ providerId }: { providerId: string }) {
  const icon = PROVIDER_ICONS[providerId] || "?";
  return (
    <span
      className="inline-flex h-4 w-4 items-center justify-center rounded text-[10px] font-bold bg-surface-elevated text-text-subtle shrink-0"
      title={providerId}
    >
      {icon}
    </span>
  );
}
