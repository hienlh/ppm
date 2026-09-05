/**
 * Permanent Tunnel Manager entry point for the named tunnel: status display
 * plus the actions that survive after the first-run popup is gone or was
 * closed early. Uses its own `useNamedTunnelSetup()` instance — see that
 * hook's docstring for why two instances stay in sync without a shared store.
 */
import { useState } from "react";
import { ExternalLink, Copy, Check, ShieldAlert, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { namedTunnelApi } from "@/lib/api-named-tunnel";
import { copyToClipboard } from "@/lib/clipboard";
import { useNamedTunnelSetup } from "./use-named-tunnel-setup";
import { NamedTunnelSetupContent } from "./named-tunnel-setup-content";
import { namedTunnelCopy } from "./named-tunnel-copy";

export function NamedTunnelSection() {
  const t = useNamedTunnelSetup();
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [copied, setCopied] = useState(false);
  const c = namedTunnelCopy.section;
  const status = t.status;

  if (!status) return null; // still loading — avoid flashing empty controls

  // "ask-domain" is the popup's own opening question; the section skips it and
  // shows a plain "Set up" button instead, since clicking that button already
  // means "yes".
  const inFlow = t.step.k !== "hidden" && t.step.k !== "ask-domain";

  async function handleDisable() {
    if (!confirmDisable) {
      setConfirmDisable(true);
      setTimeout(() => setConfirmDisable(false), 4000);
      return;
    }
    setConfirmDisable(false);
    setDisabling(true);
    try {
      await namedTunnelApi.disable();
      toast.success("Đã chuyển về quick tunnel");
      await t.refreshStatus();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Không chuyển được về quick tunnel");
    } finally {
      setDisabling(false);
    }
  }

  async function copyHostname(hostname: string) {
    const ok = await copyToClipboard(`https://${hostname}`);
    if (!ok) { toast.error("Failed to copy URL"); return; }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="p-3 border-b border-border bg-surface space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-text-primary">{c.title}</span>
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide ${
          status.mode === "named" ? "bg-success/10 text-success" : "bg-surface-elevated text-text-secondary"
        }`}>
          {status.mode === "named" ? c.modeNamed : c.modeQuick}
        </span>
      </div>

      {status.mode === "named" && status.hostname && (
        <div className="flex items-center gap-1 text-xs">
          <a href={`https://${status.hostname}`} target="_blank" rel="noopener noreferrer" className="flex-1 min-w-0 truncate text-primary hover:underline">
            {status.hostname}
          </a>
          <button
            onClick={() => copyHostname(status.hostname!)}
            aria-label="Copy URL"
            className="shrink-0 size-8 flex items-center justify-center rounded-md hover:bg-surface-elevated transition-colors"
          >
            {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5 text-text-secondary" />}
          </button>
          <a
            href={`https://${status.hostname}`} target="_blank" rel="noopener noreferrer"
            className="shrink-0 size-8 flex items-center justify-center rounded-md hover:bg-surface-elevated transition-colors"
          >
            <ExternalLink className="size-3.5 text-text-secondary" />
          </a>
        </div>
      )}

      {status.tokenMasked && (
        <p className="text-[10px] font-mono text-text-subtle">{c.tokenLabel}: {status.tokenMasked}</p>
      )}

      {status.tunnelWarning && (
        <div className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-xs text-foreground">
          <AlertTriangle className="size-3.5 text-warning shrink-0" />
          {status.tunnelWarning}
        </div>
      )}

      {status.certState === "invalid" && !inFlow && (
        <div className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-xs text-foreground">
          <ShieldAlert className="size-3.5 text-warning shrink-0" />
          {c.certInvalid}
        </div>
      )}

      {inFlow ? (
        <NamedTunnelSetupContent step={t.step} t={t} />
      ) : (
        <div className="flex flex-wrap gap-2">
          {status.mode === "quick" && (
            <button
              onClick={t.answerYes}
              className="px-3 py-2 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
            >
              {c.setup}
            </button>
          )}
          {status.mode === "named" && (
            <button
              onClick={handleDisable}
              disabled={disabling}
              className={`px-3 py-2 rounded-md text-xs transition-colors disabled:opacity-50 ${
                confirmDisable ? "bg-destructive/15 text-destructive" : "border border-border text-text-secondary hover:bg-surface-elevated"
              }`}
            >
              {confirmDisable ? c.disableConfirm : c.disable}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
