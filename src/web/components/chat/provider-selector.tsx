import { useState, useEffect, useRef, useCallback, type KeyboardEvent } from "react";
import { Check } from "@/lib/icons";
import { getChatProviders, peekChatProviders } from "@/lib/chat-preparation-cache";
import { PROVIDER_LOGOS } from "@/lib/provider-logos";
import { cn } from "@/lib/utils";

interface ProviderInfo {
  id: string;
  name: string;
}

interface ProviderSelectorProps {
  value: string;
  onChange: (providerId: string) => void;
  projectName: string;
}

/**
 * The provider's own logo. An id with no artwork — or no id at all, which is a
 * real case, since a chat search result carries no provider — keeps the lettered
 * tile these all used to be, so it still reads as a provider rather than as a
 * gap in the row.
 */
function ProviderIcon({ providerId, className }: { providerId: string | undefined; className: string }) {
  const Logo = providerId ? PROVIDER_LOGOS[providerId] : undefined;
  if (Logo) return <Logo className={cn("shrink-0", className)} />;
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded bg-surface-elevated text-[10px] font-bold text-text-subtle shrink-0",
        className,
      )}
    >
      ?
    </span>
  );
}

/**
 * Provider selector chip + popup — matches ModeSelector style.
 * Available immediately; discover alternatives when opened.
 */
export function ProviderSelector({ value, onChange, projectName }: ProviderSelectorProps) {
  const [result, setResult] = useState<{ projectName: string; providers: ProviderInfo[]; error?: boolean } | null>(null);
  const providers = result?.projectName === projectName ? result.providers : peekChatProviders(projectName) ?? [];
  const error = result?.projectName === projectName && result.error;
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef(0);

  useEffect(() => {
    if (!open || !projectName) return;
    let active = true;
    getChatProviders(projectName)
      .then((providers) => { if (active) setResult({ projectName, providers }); })
      .catch(() => { if (active) setResult({ projectName, providers: peekChatProviders(projectName) ?? [], error: true }); });
    return () => { active = false; };
  }, [projectName, open]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    // The panel's own document — in a picture-in-picture window the main
    // document never sees these clicks, so the panel would never close.
    const doc = panelRef.current?.ownerDocument ?? document;
    doc.addEventListener("mousedown", handler);
    return () => doc.removeEventListener("mousedown", handler);
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
      if (!providers.length) return;
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

  const current = providers.find((p) => p.id === value);

  return (
    <div className="relative">
      {/* Chip — same style as ModeChip */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="inline-flex items-center gap-1.5 px-[9px] py-1 rounded-full text-[11.5px] text-text-2 bg-panel-2 border border-border-soft hover:text-text-primary hover:border-border transition-colors"
        aria-label={`AI Provider: ${current?.name ?? value}`}
      >
        <ProviderIcon providerId={value} className="size-3.5" />
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
          className="absolute bottom-full left-0 mb-1 z-50 w-56 rounded-lg border border-border popover-solid shadow-[var(--shadow-panel)]"
        >
          <div className="px-3 py-2 border-b border-border">
            <span className="text-xs font-medium text-text-secondary">Provider</span>
          </div>
          <div className="py-1">
            {providers.length === 0 && <div role="status" className="px-3 py-2 text-xs text-text-secondary">{error ? "Unable to load providers" : result?.projectName === projectName ? "No providers available" : "Loading providers..."}</div>}
            {providers.map((p, idx) => {
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
                  <ProviderIcon providerId={p.id} className="size-4" />
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

/** Small provider badge for session lists. */
export function ProviderBadge({ providerId }: { providerId: string | undefined }) {
  // The tooltip sits on a wrapper on purpose: a `title` *attribute* on an `<svg>`
  // draws nothing (SVG wants a `<title>` child), so the name would be lost.
  return (
    <span className="inline-flex shrink-0" title={providerId}>
      <ProviderIcon providerId={providerId} className="size-4" />
    </span>
  );
}
