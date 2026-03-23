import { useRef, useEffect, useCallback, type KeyboardEvent } from "react";
import { Hand, Code, ClipboardList, ShieldOff, Check } from "lucide-react";

const MODES = [
  { id: "default", label: "Ask before edits", icon: Hand, description: "Claude will ask for approval before making each edit" },
  { id: "acceptEdits", label: "Edit automatically", icon: Code, description: "Claude will edit files without asking first" },
  { id: "plan", label: "Plan mode", icon: ClipboardList, description: "Claude will present a plan before editing" },
  { id: "bypassPermissions", label: "Bypass permissions", icon: ShieldOff, description: "Claude will not ask before running commands" },
] as const;

export type ModeId = typeof MODES[number]["id"];

/** Short label for the mode chip */
export function getModeLabel(id: string): string {
  return MODES.find((m) => m.id === id)?.label ?? "Unknown";
}

/** Icon component for the mode chip */
export function getModeIcon(id: string) {
  return MODES.find((m) => m.id === id)?.icon ?? Hand;
}

interface ModeSelectorProps {
  value: string;
  onChange: (mode: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ModeSelector({ value, onChange, open, onOpenChange }: ModeSelectorProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef(0);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onOpenChange]);

  // Focus current mode on open
  useEffect(() => {
    if (open) {
      focusedRef.current = MODES.findIndex((m) => m.id === value);
      if (focusedRef.current < 0) focusedRef.current = 0;
    }
  }, [open, value]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      onOpenChange(false);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      focusedRef.current = (focusedRef.current + dir + MODES.length) % MODES.length;
      const el = panelRef.current?.querySelector(`[data-idx="${focusedRef.current}"]`) as HTMLElement;
      el?.focus();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const mode = MODES[focusedRef.current];
      if (mode) { onChange(mode.id); onOpenChange(false); }
    }
  }, [onChange, onOpenChange]);

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      role="listbox"
      aria-label="Permission modes"
      onKeyDown={handleKeyDown}
      className="absolute bottom-full left-0 mb-1 z-50 w-72 md:w-80 rounded-lg border border-border bg-surface shadow-lg"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-medium text-text-secondary">Modes</span>
        <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-surface-elevated text-text-subtle border border-border">
          Shift + Tab
        </kbd>
      </div>
      <div className="py-1">
        {MODES.map((mode, idx) => {
          const Icon = mode.icon;
          const isActive = mode.id === value;
          return (
            <button
              key={mode.id}
              data-idx={idx}
              role="option"
              aria-selected={isActive}
              tabIndex={0}
              onClick={() => { onChange(mode.id); onOpenChange(false); }}
              className={`w-full flex items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-elevated focus:bg-surface-elevated focus:outline-none ${isActive ? "bg-surface-elevated" : ""}`}
            >
              <Icon className="size-4 mt-0.5 shrink-0 text-text-secondary" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-text-primary">{mode.label}</div>
                <div className="text-xs text-text-subtle leading-snug">{mode.description}</div>
              </div>
              {isActive && <Check className="size-4 mt-0.5 shrink-0 text-primary" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
