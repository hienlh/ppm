/**
 * The transcript card for the AI's vault tools. A secure or sealed read is drawn as a count
 * ("Read 2 vault items") and its output is never put on screen — live or rebuilt from history —
 * and a proposal shows its name, kind and suggested tier, never the value the AI may have sent.
 */
import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, Lock, XCircle } from "@/lib/icons";
import { tabToolResultText } from "@/lib/tab-tool-call";
import { lockedReadSummary, type VaultToolCall } from "@/lib/vault-tool-call";
import { VAULT_KIND_LABELS, VAULT_TIER_LABELS } from "../../../shared/vault";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function summaryOf(call: VaultToolCall, hiddenCount: number | null): string {
  if (call.tool === "vault_list") return "List vault items";
  if (call.tool === "vault_read") {
    if (hiddenCount !== null) return `Read ${plural(hiddenCount, "vault item")}`;
    return `Read vault: ${plural(call.items.length, "item")}`;
  }
  const kind = call.kind ? ` · ${VAULT_KIND_LABELS[call.kind]}` : "";
  return `Propose saving “${call.name || "an item"}”${kind}`;
}

export function VaultToolCard({ call, toolUseId, output, isError, done }: {
  call: VaultToolCall;
  toolUseId?: string;
  /** The tool's raw result, when it has one. */
  output?: string;
  isError: boolean;
  done: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // An error never carries a value (the server words it), so only a successful read is checked.
  const hidden = output !== undefined && !isError ? lockedReadSummary(output) : null;
  const shownOutput = output !== undefined && !hidden ? tabToolResultText(output) : null;

  return (
    <div data-tool-ref={toolUseId} data-vault-tool-card={call.tool} className="rounded-[11px] border border-border overflow-hidden text-xs bg-panel">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex items-center gap-2.5 px-2.5 py-2 w-full min-w-0 text-left can-hover:hover:bg-panel-2/40 transition-colors max-md:min-h-11"
      >
        <span className="inline-flex items-center justify-center size-6 rounded-[7px] shrink-0 bg-warning/15 text-warning">
          <Lock className="size-3.5" />
        </span>
        <span className="truncate text-text font-medium" data-vault-summary="">{summaryOf(call, hidden?.count ?? null)}</span>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          {isError
            ? <XCircle className="size-3.5 text-error" />
            : done
              ? <CheckCircle2 className="size-3.5 text-success" />
              : <Loader2 className="size-3.5 text-primary animate-spin" />}
          {expanded ? <ChevronDown className="size-3 text-text-3" /> : <ChevronRight className="size-3 text-text-3" />}
        </span>
      </button>
      {expanded && (
        <div className="px-2.5 pb-2 space-y-1.5 select-text" data-vault-details="">
          {call.tool === "vault_read" && call.purpose && (
            <p className="text-text-secondary"><span className="text-text-subtle">Purpose: </span>{call.purpose}</p>
          )}
          {call.tool === "vault_propose" && (
            <p className="text-text-secondary">
              {call.name || "Unnamed"}
              {call.kind && ` · ${VAULT_KIND_LABELS[call.kind]}`}
              {call.tier && ` · suggested tier: ${VAULT_TIER_LABELS[call.tier]}`}
              {call.hasValue && <span className="text-text-subtle"> · with a value (not shown)</span>}
            </p>
          )}
          {hidden && <p className="text-text-subtle">The values went to the AI and are not shown here.</p>}
          {shownOutput && (
            <pre className="whitespace-pre-wrap break-words font-mono text-text-secondary max-h-60 overflow-auto bg-background rounded p-2 border border-border">
              {shownOutput}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
