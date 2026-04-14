import { useState, useEffect, useCallback, useRef } from "react";
import { RotateCcw, AlertTriangle, Lock, Puzzle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  KEY_ACTIONS,
  useKeybindingsStore,
  formatCombo,
  comboFromEvent,
  type KeyCategory,
} from "@/stores/keybindings-store";
import { useExtensionStore } from "@/stores/extension-store";

const CATEGORIES: { key: KeyCategory; label: string }[] = [
  { key: "general", label: "General" },
  { key: "tabs", label: "Tabs" },
  { key: "projects", label: "Projects" },
];

const BROWSER_RESERVED = [
  "Ctrl+T", "Ctrl+W", "Ctrl+N", "Ctrl+Tab",
  "Ctrl+L", "Ctrl+H", "Ctrl+J", "F5", "Ctrl+R",
  "Ctrl+Shift+I", "Ctrl+Shift+J",
];

/** A single shortcut badge — click to record, Escape to cancel */
function ShortcutBadge({
  actionId,
  combo,
  locked,
}: {
  actionId: string;
  combo: string;
  locked?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const setBinding = useKeybindingsStore((s) => s.setBinding);
  const badgeRef = useRef<HTMLButtonElement>(null);

  const handleRecord = useCallback(
    (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const newCombo = comboFromEvent(e);
      if (newCombo) {
        setBinding(actionId, newCombo);
        setRecording(false);
      }
    },
    [actionId, setBinding],
  );

  useEffect(() => {
    if (!recording) return;
    document.addEventListener("keydown", handleRecord, true);
    return () => document.removeEventListener("keydown", handleRecord, true);
  }, [recording, handleRecord]);

  // Close recording on outside click
  useEffect(() => {
    if (!recording) return;
    const handler = (e: MouseEvent) => {
      if (badgeRef.current && !badgeRef.current.contains(e.target as Node)) {
        setRecording(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [recording]);

  if (locked) {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-border bg-muted px-2 py-0.5 text-[11px] font-mono text-muted-foreground">
        <Lock className="size-2.5" />
        {formatCombo(combo)}
      </span>
    );
  }

  if (recording) {
    return (
      <button
        ref={badgeRef}
        className="inline-flex items-center rounded border-2 border-primary bg-primary/10 px-2 py-0.5 text-[11px] font-mono text-primary animate-pulse"
      >
        Press keys...
      </button>
    );
  }

  return (
    <button
      ref={badgeRef}
      onClick={() => setRecording(true)}
      className="inline-flex items-center rounded border border-border bg-surface px-2 py-0.5 text-[11px] font-mono text-foreground hover:border-primary hover:bg-primary/5 transition-colors cursor-pointer"
      title="Click to change shortcut"
    >
      {formatCombo(combo)}
    </button>
  );
}

export function KeyboardShortcutsSection() {
  const { getBinding, resetBinding, resetAll, overrides } = useKeybindingsStore();
  const extContributions = useExtensionStore((s) => s.contributions);
  const extKeybindings = extContributions?.keybindings ?? [];
  const extCommands = extContributions?.commands ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-text-secondary">Keyboard Shortcuts</h3>
        {Object.keys(overrides).length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[10px] text-muted-foreground"
            onClick={resetAll}
          >
            <RotateCcw className="size-3 mr-1" />
            Reset all
          </Button>
        )}
      </div>

      {/* Browser warning */}
      <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2">
        <AlertTriangle className="size-3.5 text-amber-500 shrink-0 mt-0.5" />
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Some shortcuts ({BROWSER_RESERVED.slice(0, 4).join(", ")}...) are reserved by the browser and cannot be overridden.
        </p>
      </div>

      {/* Categories */}
      {CATEGORIES.map((cat) => {
        const actions = KEY_ACTIONS.filter((a) => a.category === cat.key);
        if (actions.length === 0) return null;
        return (
          <div key={cat.key} className="space-y-1">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
              {cat.label}
            </span>
            <div className="space-y-0.5">
              {actions.map((action) => {
                const currentCombo = getBinding(action.id);
                const isOverridden = action.id in overrides;
                return (
                  <div
                    key={action.id}
                    className="flex items-center justify-between py-1 px-1 rounded hover:bg-surface-elevated/50 transition-colors"
                  >
                    <div className="flex flex-col min-w-0">
                      <span className="text-xs text-foreground">{action.label}</span>
                      {action.note && (
                        <span className="text-[10px] text-muted-foreground">{action.note}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0 ml-2">
                      <ShortcutBadge
                        actionId={action.id}
                        combo={currentCombo}
                        locked={action.locked}
                      />
                      {isOverridden && !action.locked && (
                        <button
                          onClick={() => resetBinding(action.id)}
                          className="flex items-center justify-center size-5 rounded text-muted-foreground hover:text-foreground hover:bg-surface-elevated transition-colors"
                          title="Reset to default"
                        >
                          <RotateCcw className="size-3" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Extension-contributed keybindings */}
      {extKeybindings.length > 0 && (
        <div className="space-y-1">
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
            Extensions
          </span>
          <div className="space-y-0.5">
            {extKeybindings.map((kb) => {
              const cmd = extCommands.find((c) => c.command === kb.command);
              const label = cmd?.title ?? kb.command;
              const actionId = `ext:${kb.command}`;
              const currentCombo = getBinding(actionId) || kb.key;
              const isOverridden = actionId in overrides;
              return (
                <div
                  key={actionId}
                  className="flex items-center justify-between py-1 px-1 rounded hover:bg-surface-elevated/50 transition-colors"
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Puzzle className="size-3 text-muted-foreground shrink-0" />
                    <span className="text-xs text-foreground">{label}</span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 ml-2">
                    <ShortcutBadge actionId={actionId} combo={currentCombo} />
                    {isOverridden && (
                      <button
                        onClick={() => resetBinding(actionId)}
                        className="flex items-center justify-center size-5 rounded text-muted-foreground hover:text-foreground hover:bg-surface-elevated transition-colors"
                        title="Reset to default"
                      >
                        <RotateCcw className="size-3" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
