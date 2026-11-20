/**
 * A sealed value the user unlocked to see for themselves. It travels only in the card's HTTP
 * answer, and the card itself leaves the moment `approval_resolved` arrives — so the value is
 * shown in a toast on this device instead, with Copy, and hides itself after `VAULT_SHOW_MS`.
 * Nothing keeps it after that: the toast's own state is the only copy in the page.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, Lock } from "@/lib/icons";
import { copyToClipboard } from "@/lib/clipboard";
import { useNow } from "@/hooks/use-now";
import { formatCountdown } from "@/lib/vault-client";
import { VAULT_SHOW_MS } from "../../../shared/vault";

export function VaultShownValue({ name, value, until, onHide }: { name: string; value: string; until: number; onHide: () => void }) {
  const now = useNow(true);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (now >= until) onHide();
  }, [now, until, onHide]);

  return (
    <div className="w-[min(92vw,22rem)] rounded-lg border-2 border-error/50 bg-popover p-3 text-popover-foreground shadow-lg space-y-2" data-vault-shown="">
      <div className="flex items-center gap-2 text-xs font-medium text-error">
        <Lock className="size-4" />
        <span className="min-w-0 truncate">{name}</span>
        <span className="ml-auto font-mono text-text-subtle">{formatCountdown(until - now)}</span>
      </div>
      <pre className="max-h-[40vh] select-text overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-background p-2 font-mono text-xs" data-vault-shown-value="">
        {value}
      </pre>
      <p className="text-[11px] text-text-subtle">Shown to you only. The AI did not get it.</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void copyToClipboard(value).then((ok) => setCopied(ok))}
          className="flex h-11 md:h-8 flex-1 items-center justify-center gap-1.5 rounded bg-primary px-3 text-xs font-medium text-primary-foreground can-hover:hover:bg-primary/80"
        >
          <Copy className="size-3.5" />
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          onClick={onHide}
          className="h-11 md:h-8 flex-1 rounded border border-border px-3 text-xs font-medium can-hover:hover:bg-panel-2"
        >
          Hide
        </button>
      </div>
    </div>
  );
}

/** Shows a sealed value for `VAULT_SHOW_MS` on this device. */
export function showVaultValue(requestId: string, shown: { name: string; value: string }): void {
  const id = `vault-shown-${requestId}`;
  const until = Date.now() + VAULT_SHOW_MS;
  toast.custom(() => <VaultShownValue name={shown.name} value={shown.value} until={until} onHide={() => toast.dismiss(id)} />, {
    id,
    duration: VAULT_SHOW_MS,
  });
}
