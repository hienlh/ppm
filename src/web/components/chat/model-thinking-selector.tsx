import { useState, useEffect, useRef, type ReactNode } from "react";
import { Check, Sparkles, Brain } from "lucide-react";
import { api, projectUrl } from "@/lib/api-client";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { EFFORT_OPTIONS, chipLabel } from "./model-thinking-selector-helpers";

interface ModelOption {
  value: string;
  label: string;
}

interface ModelThinkingSelectorProps {
  model: string | null;
  effort: string | null;
  thinking: boolean;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
  onThinkingChange: (enabled: boolean) => void;
  projectName: string;
  providerId: string;
  /** Locked while a turn is streaming (model/effort can't change mid-turn). */
  disabled?: boolean;
}

/** Strip the leading "Claude " so the chip stays compact: "Claude Opus 5" → "Opus 5" */
function shortLabel(label: string): string {
  return label.replace(/^Claude\s+/i, "");
}

const DEFAULT_EFFORT = EFFORT_OPTIONS.find((o) => o.default)!.value;

/**
 * Unified model + thinking picker — one chip, one popup. Mirrors Anthropic's native
 * picker: model list, effort levels (Extra→SDK "xhigh"), and a thinking on/off toggle.
 * Desktop → absolute popover; mobile (<md) → bottom sheet with 44px targets.
 */
export function ModelThinkingSelector({
  model,
  effort,
  thinking,
  onModelChange,
  onEffortChange,
  onThinkingChange,
  projectName,
  providerId,
  disabled,
}: ModelThinkingSelectorProps) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (!projectName || !providerId) return;
    api
      .get<ModelOption[]>(`${projectUrl(projectName)}/chat/providers/${providerId}/models`)
      .then(setModels)
      .catch(() => {});
  }, [projectName, providerId]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // Desktop popover: close on click outside (mobile bottom sheet handles its own backdrop).
  useEffect(() => {
    if (!open || isMobile) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    // The panel's own document — in a picture-in-picture window the main
    // document never sees these clicks, so the panel would never close.
    const doc = panelRef.current?.ownerDocument ?? document;
    doc.addEventListener("mousedown", handler);
    return () => doc.removeEventListener("mousedown", handler);
  }, [open, isMobile]);

  const current = models.find((m) => m.value === model);
  const modelDisplay = current ? shortLabel(current.label) : model ? shortLabel(model) : "Model";
  const effortValue = effort ?? DEFAULT_EFFORT;
  const showModelList = models.length > 1;
  const chipText = chipLabel(modelDisplay, effortValue);

  const pick = (fn: () => void) => {
    fn();
    if (!isMobile) setOpen(false);
  };

  const content = (
    <div className="flex divide-x divide-border">
      {/* Left column: model list */}
      {showModelList && (
        <div className="flex-1 min-w-0 py-1">
          <SectionLabel>Model</SectionLabel>
          {models.map((m) => (
            <OptionRow key={m.value} active={m.value === model} onClick={() => pick(() => onModelChange(m.value))}>
              <span className="flex-1 truncate">{shortLabel(m.label)}</span>
              {m.value === model && <Check className="size-4 shrink-0 text-primary" />}
            </OptionRow>
          ))}
        </div>
      )}
      {/* Right column: effort + thinking toggle */}
      <div className="flex-1 min-w-0 py-1">
        <SectionLabel>Effort</SectionLabel>
        {EFFORT_OPTIONS.map((o) => (
          <OptionRow key={o.value} active={o.value === effortValue} onClick={() => pick(() => onEffortChange(o.value))}>
            <span className="flex-1 truncate">
              {o.label}
              {o.default && <span className="ml-2 text-xs text-text-subtle">Default</span>}
            </span>
            {o.value === effortValue && <Check className="size-4 shrink-0 text-primary" />}
          </OptionRow>
        ))}
        <Separator />
        <button
          type="button"
          onClick={() => onThinkingChange(!thinking)}
          className="w-full flex items-center gap-3 px-3 min-h-[44px] text-left text-sm hover:bg-surface-elevated"
          role="switch"
          aria-checked={thinking}
        >
          <Brain className="size-4 shrink-0" />
          <span className="flex-1">Thinking</span>
          <span className={`inline-flex h-5 w-9 items-center rounded-full transition-colors ${thinking ? "bg-primary" : "bg-border"}`}>
            <span className={`h-4 w-4 rounded-full bg-white transition-transform ${thinking ? "translate-x-4" : "translate-x-0.5"}`} />
          </span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) setOpen((v) => !v);
        }}
        className="inline-flex items-center gap-1.5 px-[9px] py-1 rounded-full text-[11.5px] text-primary bg-accent-wash border border-accent-wash-border hover:brightness-110 transition-[filter] disabled:opacity-50 disabled:cursor-default"
        aria-label={`Model ${modelDisplay}, effort ${effortValue}${thinking ? ", thinking on" : ""}`}
        title={disabled ? "Can't change while running" : chipText}
      >
        <Sparkles className="h-3.5 w-3.5 shrink-0" />
        <span className="max-w-[140px] truncate">{chipText}</span>
        {thinking && <Brain className="h-3 w-3 shrink-0" />}
      </button>

      {open && !disabled && (
        isMobile ? (
          <BottomSheet open={open} onClose={() => setOpen(false)}>
            <div className="px-1 pb-2">{content}</div>
          </BottomSheet>
        ) : (
          <div
            ref={panelRef}
            role="listbox"
            aria-label="Model and thinking"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className="absolute bottom-full left-0 mb-1 z-50 w-80 rounded-lg border border-border popover-solid shadow-[var(--shadow-panel)] max-h-[70vh] overflow-y-auto"
          >
            {content}
          </div>
        )
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="px-3 py-1.5 text-xs font-medium text-text-secondary">{children}</div>;
}

function Separator() {
  return <div className="my-1 border-t border-border" />;
}

function OptionRow({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 min-h-[44px] text-left text-sm text-text-primary transition-colors hover:bg-surface-elevated ${active ? "bg-surface-elevated" : ""}`}
    >
      {children}
    </button>
  );
}
