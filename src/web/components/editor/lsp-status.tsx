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
 * Nothing here installs anything on its own. An editor that reaches out to the
 * network and installs a binary because a file was opened is doing something
 * the user did not ask for — but a button that says Install is the user asking,
 * so the missing server has one, and the command stays for anyone who would
 * rather run it themselves or whose server is not one PPM can install.
 *
 * The same argument is why the *off* state has a chip. A language server is a
 * real process on the host — one was 854 MB resident — so PPM keeps it off
 * until asked, and a feature that is off with nothing on screen to say so is
 * the same invisible failure as a feature that is missing. So: one chip that
 * says "off" and turns it on, and the switch to turn it back off in the panel
 * the on-state chip opens.
 */
import { useState } from "react";
import { AlertTriangle, Check, Copy, Download, Loader2, Zap, ZapOff } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { LspDocumentStatus, LspMissingServer } from "@/lib/lsp/lsp-client";
import type { LspDiagnostic } from "@/hooks/use-lsp";

interface LspStatusProps {
  /** The setting, for this device. False renders the chip that turns it on. */
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  status: LspDocumentStatus | null;
  diagnostics: LspDiagnostic[];
  /**
   * Install the missing server, and reopen this file against it.
   *
   * Comes from the language service, which is behind a `lazy()` — this component is on the
   * editor's static path, so it may not reach the LSP client itself.
   */
  onInstall?: (serverId: string) => Promise<void>;
}

export function LspStatus({ enabled, onToggle, status, diagnostics, onInstall }: LspStatusProps) {
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
          onInstall={onInstall}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function LspStatusDetails({
  status, errors, warnings, isMobile, onToggle, onInstall, onClose,
}: {
  status: LspDocumentStatus;
  errors: number;
  warnings: number;
  isMobile: boolean;
  onToggle: (enabled: boolean) => void;
  onInstall?: (serverId: string) => Promise<void>;
  onClose: () => void;
}) {
  const body = (
    <LspStatusBody
      status={status}
      errors={errors}
      warnings={warnings}
      isMobile={isMobile}
      onToggle={onToggle}
      onInstall={onInstall}
    />
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
  status, errors, warnings, isMobile, onToggle, onInstall,
}: {
  status: LspDocumentStatus;
  errors: number;
  warnings: number;
  isMobile: boolean;
  onToggle: (enabled: boolean) => void;
  onInstall?: (serverId: string) => Promise<void>;
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
              {status.reason === "not-installed" && status.server.installable && onInstall ? (
                <>
                  <p className="text-xs text-muted-foreground">{installNote(status.server.installWith)}</p>
                  <InstallServerButton server={status.server} isMobile={isMobile} onInstall={onInstall} />
                  <p className="text-xs text-muted-foreground">Or run it yourself:</p>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">{cannotInstallNote(status.server.installWith)}</p>
              )}
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

/**
 * What pressing Install will actually do.
 *
 * Worth saying, because the three are not the same promise: two of them leave the machine's own
 * tools untouched, and the rustup one deliberately does not — a rust-analyzer belongs to a
 * toolchain, so PPM adds the component rather than keeping a copy that would be the wrong one
 * for a project pinning another toolchain.
 */
function installNote(installWith: LspMissingServer["installWith"]): string {
  switch (installWith) {
    case "go":
      return "PPM builds it with the Go on this machine and keeps the binary in its own folder,"
        + " leaving your GOBIN alone. A first build takes a minute or two.";
    case "rustup":
      return "PPM asks rustup to add the component to the toolchain this project uses — the same"
        + " as running the command below yourself.";
    default:
      return "PPM downloads it from npm into its own folder. Nothing you installed globally"
        + " changes, and this file picks it up without being reopened.";
  }
}

/** Why there is no button: either PPM has no toolchain to do it with, or it is a system package. */
function cannotInstallNote(installWith: LspMissingServer["installWith"]): string {
  switch (installWith) {
    case "go":
      return "Install it, then reopen this file. PPM installs language servers but never toolchains,"
        + " and it cannot find a Go on this host.";
    case "rustup":
      return "Install it, then reopen this file. PPM installs language servers but never toolchains,"
        + " and it cannot find rustup on this host.";
    default:
      return "Install it, then reopen this file. This one comes from a system package manager,"
        + " which PPM will not run on your behalf.";
  }
}

/**
 * The Install button, and whatever the host said when it did not work.
 *
 * The progress is this component's own state rather than the caller's, so closing the dialog
 * mid-install cancels nothing: the host finishes either way and the file's status is what
 * reports it. Reopening during one shows an idle button, and pressing it again joins the
 * install already running rather than starting a second over the same lockfile.
 */
function InstallServerButton({
  server, isMobile, onInstall,
}: {
  server: LspMissingServer;
  isMobile: boolean;
  onInstall: (serverId: string) => Promise<void>;
}) {
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <Button
        type="button"
        disabled={installing}
        onClick={() => {
          setInstalling(true);
          setError(null);
          onInstall(server.id)
            .catch((e) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setInstalling(false));
        }}
        className={`w-full ${isMobile ? "min-h-11" : ""}`}
      >
        {installing ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
        {installing ? `Installing ${server.displayName}…` : `Install ${server.displayName}`}
      </Button>
      {error && <p className="text-xs text-red-500 break-words">{error}</p>}
    </>
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
