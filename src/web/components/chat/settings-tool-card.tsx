/**
 * The transcript card for the PPM Assistant's settings tools: each setting it changed as
 * before → after, how it was allowed (Full mode with no card, or a card the user allowed), and an
 * Undo per change — the user's own press, so it needs no card; a value changed since is left as it
 * is and the reason is shown. A background install (Whisper, the relay) shows its progress here.
 */
import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Loader2, Settings2, Undo2, XCircle } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { approvalLabel, settingsToolMessage, settingsToolResult, settingsToolTitle, type SettingsToolCall } from "@/lib/settings-tool-call";
import { undoSettingChange } from "@/lib/assistant-settings-changes-client";
import { InstallProgress } from "./settings-install-progress";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function SettingsToolCard({ call, toolUseId, output, isError, done }: {
  call: SettingsToolCall;
  toolUseId?: string;
  output?: string;
  isError: boolean;
  done: boolean;
}) {
  const result = isError ? null : settingsToolResult(output);
  const [undone, setUndone] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState<number | null>(null);
  const how = approvalLabel(result?.approval);
  const writes = call.tool === "settings_set" || call.tool === "settings_undo" || call.tool === "settings_install";
  // A read's answer is for the AI; a write's card says what happened, in a person's words.
  const message = output === undefined || (!writes && !isError) ? null : settingsToolMessage(output, isError, result);
  const declined = !!message && message.startsWith("Not changed:");

  const undo = async (id: number) => {
    setBusy(id);
    try {
      await undoSettingChange(id);
      setUndone((s) => new Set(s).add(id));
    } catch (e) {
      toast.error("Not undone", { description: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-tool-ref={toolUseId} data-settings-tool-card={call.tool} className="rounded-[11px] border border-border overflow-hidden text-xs bg-panel">
      <div className="flex items-center gap-2.5 px-2.5 py-2 min-w-0 max-md:min-h-11">
        <span className={cn("inline-flex items-center justify-center size-6 rounded-[7px] shrink-0", result?.outcome === "changed" || result?.outcome === "undone" ? "bg-success/15 text-success" : "bg-primary/15 text-primary")}>
          <Settings2 className="size-3.5" />
        </span>
        <span className="truncate text-text font-medium" data-settings-title="">{settingsToolTitle(call, result)}</span>
        {how && <span className="hidden sm:inline text-text-subtle truncate" data-settings-approval="">· {how}</span>}
        <span className="ml-auto shrink-0">
          {isError ? <XCircle className="size-3.5 text-error" /> : done ? <CheckCircle2 className="size-3.5 text-success" /> : <Loader2 className="size-3.5 text-primary animate-spin" />}
        </span>
      </div>
      {how && <div className="sm:hidden px-2.5 -mt-1 pb-1 text-text-subtle">{how}</div>}
      {result && result.changes.length > 0 && call.tool !== "settings_install" && (
        <ul className="border-t border-border divide-y divide-border/60">
          {result.changes.map((c) => (
            <li key={c.changeId} className="flex items-center gap-2 px-2.5 py-1.5" data-setting-change={c.changeId}>
              <div className="min-w-0 flex-1">
                <div className="text-text-secondary break-words">{c.label}</div>
                <div className="break-words">
                  <span className="text-text-subtle line-through">{c.before}</span>
                  <span className="px-1 text-text-subtle">→</span>
                  <span className="font-semibold text-text">{c.after}</span>
                </div>
              </div>
              {call.tool === "settings_set" && (undone.has(c.changeId)
                ? <span className="shrink-0 text-text-subtle">Undone</span>
                : (
                  <button type="button" disabled={busy !== null} onClick={() => void undo(c.changeId)} data-undo-change={c.changeId}
                    className="shrink-0 inline-flex items-center gap-1 rounded-md border border-border px-2.5 min-h-11 md:min-h-7 text-text can-hover:hover:bg-panel-2 disabled:opacity-50">
                    {busy === c.changeId ? <Loader2 className="size-3 animate-spin" /> : <Undo2 className="size-3" />} Undo
                  </button>
                ))}
            </li>
          ))}
        </ul>
      )}
      {result?.outcome === "installing" && result.install && (
        <div className="border-t border-border px-2.5 py-2"><InstallProgress component={result.install.component} /></div>
      )}
      {message && <p className={cn("border-t border-border px-2.5 py-1.5 whitespace-pre-wrap break-words", isError && !declined ? "text-error" : "text-text-secondary")}>{message}</p>}
    </div>
  );
}
