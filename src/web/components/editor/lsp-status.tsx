/**
 * What the language server is doing, in the editor toolbar.
 *
 * This exists because the alternative was shipping a feature that is invisible
 * when it works and silent when it does not. On a machine with no language
 * server installed — the default state of a fresh PPM — completions simply do
 * not appear, which is indistinguishable from a bug. So the indicator is
 * always present for a file a server *could* serve, and says which of the
 * three things is true: it is working, it is starting, or it is not installed
 * and here is the one command that fixes that.
 *
 * Nothing here installs anything. The command is shown to be copied and run
 * deliberately; an editor that reaches out to the network and installs a
 * binary because a file was opened is doing something the user did not ask for.
 *
 * The same argument is why the *off* state has a chip. A language server is a
 * real process on the host — one was 854 MB resident — so PPM keeps it off
 * until asked, and a feature that is off with nothing on screen to say so is
 * the same invisible failure as a feature that is missing. So: one chip that
 * says "off" and turns it on, and the switch to turn it back off in the panel
 * the on-state chip opens.
 */
import { useState } from "react";
import { AlertTriangle, Check, Copy, Loader2, Zap, ZapOff } from "@/lib/icons";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { LspDocumentStatus } from "@/lib/lsp/lsp-client";
import type { LspDiagnostic } from "@/hooks/use-lsp";

interface LspStatusProps {
  /** The setting, for this device. False renders the chip that turns it on. */
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  status: LspDocumentStatus | null;
  diagnostics: LspDiagnostic[];
}

export function LspStatus({ enabled, onToggle, status, diagnostics }: LspStatusProps) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();

  if (!enabled) {
    return (
      <button
        type="button"
        onClick={() => onToggle(true)}
        title={
          "Language server: off. Turn it on for completions, hover, go to definition, "
          + "rename and quick fix from a real server. It runs as a process on the host."
        }
        className={`flex items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:bg-muted active:scale-95 transition-colors ${
          isMobile ? "min-h-11" : "py-0.5"
        }`}
      >
        <ZapOff className="size-3 shrink-0" />
        <span>LSP off</span>
      </button>
    );
  }

  if (!status) return null;

  const errors = diagnostics.filter((d) => d.severity === 1).length;
  const warnings = diagnostics.filter((d) => d.severity === 2).length;

  const label =
    status.state === "ready" ? status.server.displayName
    : status.state === "opening" ? "Starting…"
    : status.server?.displayName ?? "No server";

  const missing = status.state === "unavailable" && status.reason === "not-installed";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={
          status.state === "ready"
            ? `${status.server.displayName} — rooted at ${status.server.rootPath}`
            : status.state === "unavailable" ? status.message : "Starting the language server"
        }
        className={`flex items-center gap-1 rounded px-1.5 hover:bg-muted active:scale-95 transition-colors text-xs ${
          // 44px on touch, per the mobile rules; compact on a pointer device.
          isMobile ? "min-h-11" : "py-0.5"
        } ${missing ? "text-amber-500" : "text-muted-foreground"}`}
      >
        {status.state === "opening" ? (
          <Loader2 className="size-3 animate-spin shrink-0" />
        ) : missing ? (
          <AlertTriangle className="size-3 shrink-0" />
        ) : (
          <Zap className="size-3 shrink-0" />
        )}
        <span className="max-w-24 truncate">{label}</span>
        {errors > 0 && <span className="text-red-500">{errors}</span>}
        {errors === 0 && warnings > 0 && <span className="text-amber-500">{warnings}</span>}
      </button>

      {open && (
        <LspStatusDetails
          status={status}
          errors={errors}
          warnings={warnings}
          isMobile={isMobile}
          onToggle={onToggle}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function LspStatusDetails({
  status, errors, warnings, isMobile, onToggle, onClose,
}: {
  status: LspDocumentStatus;
  errors: number;
  warnings: number;
  isMobile: boolean;
  onToggle: (enabled: boolean) => void;
  onClose: () => void;
}) {
  const body = (
    <LspStatusBody status={status} errors={errors} warnings={warnings} isMobile={isMobile} onToggle={onToggle} />
  );

  if (isMobile) {
    return (
      <BottomSheet open onClose={onClose} className="popover-solid max-h-[85dvh] flex flex-col">
        {body}
      </BottomSheet>
    );
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogTitle>Language server</DialogTitle>
        {body}
      </DialogContent>
    </Dialog>
  );
}

function LspStatusBody({
  status, errors, warnings, isMobile, onToggle,
}: {
  status: LspDocumentStatus;
  errors: number;
  warnings: number;
  isMobile: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <div className="p-4 space-y-4 overflow-y-auto text-sm leading-relaxed">
      {status.state === "ready" && (
        <>
          <Row label="Server" value={status.server.displayName} />
          <Row label="Language" value={status.languageId} />
          <Row label="Project root" value={status.server.rootPath} mono />
          <Row label="Problems" value={`${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`} />
          <p className="text-xs text-muted-foreground">
            Completions, hover, go to definition (F12), find references (Shift+F12), rename (F2),
            quick fix (Ctrl+.) and format (Shift+Alt+F) all come from this server.
          </p>
        </>
      )}

      {status.state === "opening" && (
        <p className="text-muted-foreground">
          Starting the language server. A cold start reads the project's dependencies, so the first
          completion in a large project can take a few seconds.
        </p>
      )}

      {status.state === "unavailable" && (
        <>
          <p>{status.message}</p>
          {status.server && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Install it, then reopen this file. PPM does not install it for you — that would mean
                fetching and running a binary because you opened a file.
              </p>
              <CopyableCommand command={status.server.installHint} isMobile={isMobile} />
            </div>
          )}
          {status.reason === "no-language" && (
            <p className="text-xs text-muted-foreground">
              No language server is registered for this file type.
            </p>
          )}
        </>
      )}

      {/* Symmetry with the chip that turned it on. The setting is per-device:
          a phone has no business starting a server because a desktop did. */}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
        <div>
          <p className="text-xs font-medium">Language server</p>
          <p className="text-[11px] text-muted-foreground">On for this device. Turning it off stops the process.</p>
        </div>
        <Switch checked onCheckedChange={(v) => onToggle(v)} />
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2 items-baseline">
      <span className="text-muted-foreground shrink-0 w-24 text-xs">{label}</span>
      <span className={`min-w-0 break-all ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}

function CopyableCommand({ command, isMobile }: { command: string; isMobile: boolean }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(command).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className={`w-full flex items-center gap-2 rounded border border-border bg-muted/40 px-3 text-left font-mono text-xs hover:bg-muted active:scale-[0.99] transition ${
        isMobile ? "min-h-11 py-3" : "py-2"
      }`}
    >
      <span className="flex-1 break-all">{command}</span>
      {copied ? <Check className="size-3.5 shrink-0 text-green-500" /> : <Copy className="size-3.5 shrink-0 opacity-60" />}
    </button>
  );
}
