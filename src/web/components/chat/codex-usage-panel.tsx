import { X } from "lucide-react";
import { CodexAccountsSection } from "../settings/codex-accounts-section";

/** Codex analog of UsageDetailPanel — opened from the chat toolbar usage badge.
 * Reuses the settings accounts section (per-account usage + add/remove + strategy)
 * so codex sessions get the same in-chat account/usage surface as Claude. */
export function CodexUsagePanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="border-t border-border bg-surface px-3 py-2.5 space-y-2.5 max-h-[350px] overflow-y-auto">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-text-primary">Codex Usage & Accounts</span>
        <button
          onClick={onClose}
          className="text-text-subtle hover:text-text-primary px-1 cursor-pointer"
          title="Close"
        >
          <X className="size-3" />
        </button>
      </div>
      <CodexAccountsSection />
    </div>
  );
}
