import { useState, useEffect, useRef, useCallback, type KeyboardEvent } from "react";
import { Check, Sparkles } from "lucide-react";
import { api, projectUrl } from "@/lib/api-client";

interface ModelOption {
  value: string;
  label: string;
}

interface ModelSelectorProps {
  value: string | null;
  onChange: (model: string) => void;
  projectName: string;
  providerId: string;
  /** When true, the chip is shown but not interactive (e.g. while streaming) */
  disabled?: boolean;
}

/** Strip the leading "Claude " so the chip stays compact: "Claude Opus 4.8" → "Opus 4.8" */
function shortLabel(label: string): string {
  return label.replace(/^Claude\s+/i, "");
}

/**
 * Model selector chip + popup — matches ProviderSelector style.
 * Hidden when only 1 (or no) model is available.
 * Interactive only when not disabled (model can't change mid-turn).
 */
export function ModelSelector({ value, onChange, projectName, providerId, disabled }: ModelSelectorProps) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef(0);

  useEffect(() => {
    if (!projectName || !providerId) return;
    api.get<ModelOption[]>(`${projectUrl(projectName)}/chat/providers/${providerId}/models`)
      .then(setModels)
      .catch(() => {});
  }, [projectName, providerId]);

  // Close popup if it becomes disabled mid-open
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

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
      focusedRef.current = Math.max(0, models.findIndex((m) => m.value === value));
    }
  }, [open, value, models]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      focusedRef.current = (focusedRef.current + dir + models.length) % models.length;
      const el = panelRef.current?.querySelector(`[data-idx="${focusedRef.current}"]`) as HTMLElement;
      el?.focus();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const m = models[focusedRef.current];
      if (m) { onChange(m.value); setOpen(false); }
    }
  }, [onChange, models]);

  // Hide when ≤1 model
  if (models.length <= 1) return null;

  const current = models.find((m) => m.value === value);
  const display = current ? shortLabel(current.label) : (value ?? "Model");

  return (
    <div className="relative">
      {/* Chip — same style as ProviderSelector */}
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => { e.stopPropagation(); if (!disabled) setOpen((v) => !v); }}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-subtle hover:text-text-primary hover:bg-surface-elevated transition-colors border border-transparent hover:border-border disabled:opacity-50 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:border-transparent disabled:hover:text-text-subtle"
        aria-label={`Model: ${current?.label ?? value ?? "default"}`}
        title={disabled ? "Model can't change while running" : current?.label ?? undefined}
      >
        <Sparkles className="h-3.5 w-3.5 shrink-0" />
        <span className="max-w-[90px] truncate">{display}</span>
      </button>

      {/* Popup panel */}
      {open && !disabled && (
        <div
          ref={panelRef}
          role="listbox"
          aria-label="Models"
          onKeyDown={handleKeyDown}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-full left-0 mb-1 z-50 w-56 rounded-lg border border-border bg-surface shadow-lg"
        >
          <div className="px-3 py-2 border-b border-border">
            <span className="text-xs font-medium text-text-secondary">Model</span>
          </div>
          <div className="py-1">
            {models.map((m, idx) => {
              const isActive = m.value === value;
              return (
                <button
                  key={m.value}
                  data-idx={idx}
                  role="option"
                  aria-selected={isActive}
                  tabIndex={0}
                  onClick={() => { onChange(m.value); setOpen(false); }}
                  className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-surface-elevated focus:bg-surface-elevated focus:outline-none ${isActive ? "bg-surface-elevated" : ""}`}
                >
                  <span className="flex-1 text-sm font-medium text-text-primary">{m.label}</span>
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
