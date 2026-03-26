import { useState, useEffect, useRef, useCallback, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
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
 * Provider selector chip + popup — matches ModeSelector style.
 * Hidden when only 1 provider available.
 */
export function ProviderSelector({ value, onChange, projectName }: ProviderSelectorProps) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef(0);

  useEffect(() => {
    if (!projectName) return;
    api.get<ProviderInfo[]>(`${projectUrl(projectName)}/chat/providers`)
      .then(setProviders)
      .catch(() => {});
  }, [projectName]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Focus current on open
  useEffect(() => {
    if (open) {
      focusedRef.current = Math.max(0, providers.findIndex((p) => p.id === value));
    }
  }, [open, value, providers]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      focusedRef.current = (focusedRef.current + dir + providers.length) % providers.length;
      const el = panelRef.current?.querySelector(`[data-idx="${focusedRef.current}"]`) as HTMLElement;
      el?.focus();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const p = providers[focusedRef.current];
      if (p) { onChange(p.id); setOpen(false); }
    }
  }, [onChange, providers]);

  // Hide when only 1 provider
  if (providers.length <= 1) return null;

  const current = providers.find((p) => p.id === value);
  const icon = PROVIDER_ICONS[value] || "?";

  return (
    <div className="relative">
      {/* Chip — same style as ModeChip */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-subtle hover:text-text-primary hover:bg-surface-elevated transition-colors border border-transparent hover:border-border"
        aria-label={`AI Provider: ${current?.name ?? value}`}
      >
        <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded text-[9px] font-bold bg-surface-elevated shrink-0">
          {icon}
        </span>
        <span className="max-w-[80px] truncate capitalize">{current?.name ?? value}</span>
      </button>

      {/* Popup panel — same style as ModeSelector */}
      {open && (
        <div
          ref={panelRef}
          role="listbox"
          aria-label="AI Providers"
          onKeyDown={handleKeyDown}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-full left-0 mb-1 z-50 w-56 rounded-lg border border-border bg-surface shadow-lg"
        >
          <div className="px-3 py-2 border-b border-border">
            <span className="text-xs font-medium text-text-secondary">Provider</span>
          </div>
          <div className="py-1">
            {providers.map((p, idx) => {
              const pIcon = PROVIDER_ICONS[p.id] || "?";
              const isActive = p.id === value;
              return (
                <button
                  key={p.id}
                  data-idx={idx}
                  role="option"
                  aria-selected={isActive}
                  tabIndex={0}
                  onClick={() => { onChange(p.id); setOpen(false); }}
                  className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-surface-elevated focus:bg-surface-elevated focus:outline-none ${isActive ? "bg-surface-elevated" : ""}`}
                >
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded text-[11px] font-bold bg-surface-elevated text-text-subtle shrink-0">
                    {pIcon}
                  </span>
                  <span className="flex-1 text-sm font-medium text-text-primary capitalize">{p.name}</span>
                  {isActive && <Check className="size-4 shrink-0 text-primary" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
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
