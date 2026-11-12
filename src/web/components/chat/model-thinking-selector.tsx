import { useState, useEffect, useRef, type ReactNode } from "react";
import { Check, Brain, ChevronDown, TriangleAlert } from "@/lib/icons";
import { api, projectUrl } from "@/lib/api-client";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { modelDisplayName } from "@/lib/model-display-name";
import type { EffortStatus } from "../../../shared/effort-status";
import { EFFORT_OPTIONS, chipLabel, effortLabel, effortNotice, noticeText, shownEffort, type EffortNotice } from "./model-thinking-selector-helpers";
import { ProviderChoiceRow, ProviderIcon } from "./provider-selector";

interface ModelOption {
  value: string;
  label: string;
}

// Shared by chat tabs; keep successful lists visible while refreshing an old entry.
const modelCache = new Map<string, { models: ModelOption[]; expiry: number }>();
const MODEL_CACHE_TTL = 5 * 60 * 1000;

interface ModelThinkingSelectorProps {
  model: string | null;
  effort: string | null;
  /** What overrides the effort pick outside PPM, so the chip shows the effort the turns run at. */
  effortStatus?: EffortStatus | null;
  thinking: boolean;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
  onThinkingChange: (enabled: boolean) => void;
  projectName: string;
  providerId: string;
  /** Locked while a turn is streaming (model/effort can't change mid-turn). */
  disabled?: boolean;
  /** Start the chat on another provider; offered at the top of the popup before a session exists. */
  onProviderChange?: (providerId: string) => void;
}

/** Strip the leading "Claude " on Claude provider so the chip stays compact: "Claude Opus 5" → "Opus 5" */
function shortLabel(label: string, providerId?: string): string {
  if (providerId && providerId !== "claude") return label;
  return label.replace(/^Claude\s+/i, "");
}

/**
 * Unified model + thinking picker — one chip, one popup. Mirrors Anthropic's native
 * picker: model list, effort levels (Extra→SDK "xhigh"), and a thinking on/off toggle.
 * Desktop → absolute popover; mobile (<md) → bottom sheet with 44px targets.
 */
export function ModelThinkingSelector({
  model,
  effort,
  effortStatus,
  thinking,
  onModelChange,
  onEffortChange,
  onThinkingChange,
  projectName,
  providerId,
  disabled,
  onProviderChange,
}: ModelThinkingSelectorProps) {
  const cacheKey = JSON.stringify([projectName, providerId]);
  const cached = modelCache.get(cacheKey);
  const [modelResult, setModelResult] = useState<{
    projectName: string;
    providerId: string;
    models: ModelOption[];
    error?: boolean;
  } | null>(null);
  // Never render another provider/project's options, even before effects run.
  const result = modelResult?.projectName === projectName && modelResult.providerId === providerId
    ? modelResult : cached ? { ...cached, error: false } : null;
  const models = result?.models ?? [];
  const loading = Boolean(projectName && providerId && !result);
  const modelStatus = loading ? "Loading models..." : result?.error
    ? "Unable to load models" : models.length === 0 ? "No models available" : null;
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  useEffect(() => {
    let active = true;
    setModelResult(null);
    if (!open || !projectName || !providerId) return;
    const entry = modelCache.get(cacheKey);
    if (entry && Date.now() < entry.expiry) return;
    api
      .get<ModelOption[]>(`${projectUrl(projectName)}/chat/providers/${providerId}/models`)
      .then((models) => {
        // The backend also returns [] on discovery failure. Don't replace a usable list.
        const usable = models.length > 0 ? models : entry?.models ?? models;
        if (active && models.length > 0) modelCache.set(cacheKey, { models, expiry: Date.now() + MODEL_CACHE_TTL });
        if (active) setModelResult({ projectName, providerId, models: usable });
      })
      .catch(() => {
        if (active) setModelResult({ projectName, providerId, models: entry?.models ?? [], error: !entry });
      });
    return () => { active = false; };
  }, [projectName, providerId, cacheKey, open]);

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

  const isAntigravity = providerId === "antigravity";
  const effectiveModel = isAntigravity
    ? (!model || model === "pro" ? "gemini-4-argon" : model.replace(/-(low|medium|high)$/i, ""))
    : model;
  const current = models.find((m) => m.value === effectiveModel);
  const modelDisplay = current
    ? shortLabel(current.label, providerId)
    : effectiveModel
      ? modelDisplayName(effectiveModel)
      : "Model";
  const suffixEffort = isAntigravity && model ? /-(low|medium|high)$/i.exec(model)?.[1]?.toLowerCase() : undefined;
  const shown = shownEffort(effort ?? suffixEffort, effortStatus);
  const notice = effortNotice(shown, effortStatus, modelDisplay);
  const effortOptions = isAntigravity
    ? EFFORT_OPTIONS.filter((o) => o.value === "low" || o.value === "medium" || o.value === "high")
    : EFFORT_OPTIONS;
  const showModelList = models.length > 0 || Boolean(modelStatus);
  // The effort the turns run at, which an override outside PPM can make differ from the pick.
  const chipText = chipLabel(modelDisplay, shown.level);

  const pick = (fn: () => void) => {
    fn();
    if (!isMobile) setOpen(false);
  };

  const providerName = providerId ? providerId.charAt(0).toUpperCase() + providerId.slice(1) : "";
  const content = (
    <>
    {onProviderChange && <ProviderChoiceRow value={providerId} onChange={onProviderChange} projectName={projectName} />}
    {notice && <EffortNoticeBanner notice={notice} />}
    <div className="flex divide-x divide-border">
      {/* Left column: model list */}
      {showModelList && (
        <div className="flex-1 min-w-0 py-1">
          <SectionLabel>Model</SectionLabel>
          {modelStatus && <div role="status" className="px-3 py-2 text-xs text-text-secondary">{modelStatus}</div>}
          {models.map((m) => (
            <OptionRow key={m.value} active={m.value === effectiveModel} onClick={() => pick(() => onModelChange(m.value))}>
              <span className="flex-1 truncate">{shortLabel(m.label, providerId)}</span>
              {m.value === effectiveModel && <Check className="size-4 shrink-0 text-primary" />}
            </OptionRow>
          ))}
        </div>
      )}
      {/* Right column: effort + thinking toggle */}
      <div className="flex-1 min-w-0 py-1">
        <SectionLabel>Effort</SectionLabel>
        {effortOptions.map((o) => (
          <OptionRow key={o.value} active={o.value === shown.pick} onClick={() => pick(() => onEffortChange(o.value))}>
            <span className="flex-1 truncate">
              {o.label}
              {o.default && <span className="ml-2 text-xs text-text-subtle">Default</span>}
              {o.value === shown.level && shown.level !== shown.pick && <span className="ml-2 text-xs text-warning">In effect</span>}
            </span>
            {o.value === shown.pick && <Check className="size-4 shrink-0 text-primary" />}
          </OptionRow>
        ))}
        {!isAntigravity && (
          <>
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
          </>
        )}
      </div>
    </div>
    </>
  );

  return (
    // `min-w-0`: in the composer bar this is the one chip that gives way — a long model name
    // ends in an ellipsis and the full name is in the tooltip.
    <div className="relative flex min-w-0">
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) setOpen((v) => !v);
        }}
        data-model-chip=""
        className="inline-flex h-[30px] min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap rounded-full px-[9px] text-[11.5px] text-primary @max-[420px]/chat:gap-1 @max-[420px]/chat:px-1.5 max-md:gap-1 max-md:px-1.5 transition-[background-color,transform] duration-150 motion-safe:active:scale-[0.97] can-hover:hover:bg-surface-hover disabled:cursor-default disabled:active:scale-100"
        aria-label={`Model ${modelDisplay}, effort ${shown.level ? effortLabel(shown.level) : "none"}${notice ? ` (${notice.title})` : ""}${!isAntigravity && thinking ? ", thinking on" : ""}`}
        title={disabled ? "Can't change while running" : notice ? `${providerName} · ${chipText}\n${notice.title}:${noticeText(notice.detail)}` : `${providerName} · ${chipText}`}
      >
        <ProviderIcon providerId={providerId} className="size-4" />
        <span className="block min-w-0 max-w-[180px] truncate @max-[420px]/chat:max-w-[110px] max-md:max-w-[110px]">
          {modelDisplay}
          {shown.level && <span className="@max-[420px]/chat:hidden max-md:hidden">{chipText.slice(modelDisplay.length)}</span>}
        </span>
        {notice && <TriangleAlert className="size-3 shrink-0 text-warning" />}
        {!isAntigravity && thinking && <Brain className="size-3 shrink-0" />}
        {/* Narrow: the chevron gives its room to the model name; the chip still opens the picker. */}
        <ChevronDown className="size-3 shrink-0 text-text-3 @max-[420px]/chat:hidden max-md:hidden" />
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

/** Above both columns, so it reads at full width in the phone's sheet too. */
function EffortNoticeBanner({ notice }: { notice: EffortNotice }) {
  return (
    <div role="note" className="flex gap-2 border-b border-border bg-warning/10 px-3 py-2.5 text-sm leading-relaxed text-text-secondary md:text-xs">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0">
        <div className="font-medium text-text-primary">{notice.title}</div>
        <p className="m-0 break-words">
          {notice.detail.map((part, i) => typeof part === "string"
            ? part
            : <code key={i} className="rounded bg-surface-elevated px-1 font-mono text-[0.92em]">{part.code}</code>)}
        </p>
      </div>
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
