import { useState, useEffect, useSyncExternalStore } from "react";
import { Settings, X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  getAccountSettings,
  updateAccountSettings,
  type AccountSettings,
} from "../../lib/api-settings";

interface AccountRotationSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const mdQuery = typeof window !== "undefined" ? window.matchMedia("(min-width: 768px)") : null;
function subscribeMedia(cb: () => void) {
  mdQuery?.addEventListener("change", cb);
  return () => mdQuery?.removeEventListener("change", cb);
}
function getIsDesktop() {
  return mdQuery?.matches ?? true;
}

function SettingsContent() {
  const [settings, setSettings] = useState<AccountSettings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getAccountSettings()
      .then(setSettings)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <p className="text-xs text-text-subtle py-4 text-center">Loading...</p>;
  }
  if (!settings) {
    return <p className="text-xs text-text-subtle py-4 text-center">Failed to load settings</p>;
  }

  return (
    <div className="space-y-4">
      {/* Strategy */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-text-primary">Rotation Strategy</label>
        <Select
          value={settings.strategy}
          onValueChange={async (v) => {
            const updated = await updateAccountSettings({ strategy: v as AccountSettings["strategy"] });
            setSettings(updated);
          }}
        >
          <SelectTrigger className="w-full h-9 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="round-robin">Round-robin</SelectItem>
            <SelectItem value="fill-first">Fill-first</SelectItem>
            <SelectItem value="lowest-usage">Lowest usage</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-[10px] text-text-subtle">
          {settings.strategy === "round-robin" && "Cycles through accounts evenly"}
          {settings.strategy === "fill-first" && "Uses one account until its limit, then moves on"}
          {settings.strategy === "lowest-usage" && "Picks the account with the lowest current usage"}
        </p>
      </div>

      {/* Max Retry */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-text-primary">Max Retry</label>
        <input
          type="number"
          min={0}
          value={settings.maxRetry}
          className="w-full h-9 text-xs border rounded-md px-3 bg-background"
          onChange={async (e) => {
            const v = parseInt(e.target.value, 10);
            if (!isNaN(v) && v >= 0) {
              const updated = await updateAccountSettings({ maxRetry: v });
              setSettings(updated);
            }
          }}
        />
        <p className="text-[10px] text-text-subtle">
          How many accounts to try on failure. 0 = try all available accounts.
        </p>
      </div>

      {/* Active accounts */}
      <div className="flex items-center justify-between text-xs border-t border-border pt-3">
        <span className="text-text-subtle">Active accounts</span>
        <span className="font-medium text-text-primary">{settings.activeCount}</span>
      </div>
    </div>
  );
}

export function AccountRotationSettings({ open, onOpenChange }: AccountRotationSettingsProps) {
  const isDesktop = useSyncExternalStore(subscribeMedia, getIsDesktop);

  if (!open) return null;

  // Desktop: Dialog
  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-2">
              <Settings className="size-4" /> Rotation & Retry
            </DialogTitle>
          </DialogHeader>
          <SettingsContent />
        </DialogContent>
      </Dialog>
    );
  }

  // Mobile: Bottom sheet
  return (
    <>
      <div
        className="fixed inset-0 z-50 transition-opacity duration-200 opacity-100"
        onClick={() => onOpenChange(false)}
        style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
      />
      <div
        className={cn(
          "fixed bottom-0 left-0 right-0 z-50 bg-background rounded-t-2xl border-t border-border shadow-2xl",
          "transition-transform duration-300 ease-out max-h-[85vh] overflow-y-auto",
          "translate-y-0",
        )}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-border" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <span className="text-sm font-semibold flex items-center gap-2">
            <Settings className="size-4" /> Rotation & Retry
          </span>
          <button
            onClick={() => onOpenChange(false)}
            className="flex items-center justify-center size-7 rounded-md hover:bg-surface-elevated transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Content */}
        <div className="px-4 py-4 pb-8">
          <SettingsContent />
        </div>
      </div>
    </>
  );
}
