/**
 * Settings → Remote Desktop → "Run without a monitor (Windows)".
 *
 * Installs or removes the SYSTEM helper that lets PPM bring its own disconnected Windows session
 * back to the console (`src/services/remote-desktop/win32-helper/`). Renders nothing off Windows
 * or when the host will not answer (auth off, feature off).
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { api } from "@/lib/api-client";
import { TEXT_BUTTON } from "@/lib/control-size";
import { Check, Loader2 } from "@/lib/icons";
import { HeadlessHelperConfirm } from "./remote-desktop-headless-helper-confirm";

export interface HeadlessHelperStatus {
  supported: boolean;
  usable: boolean;
  installed: boolean;
  outdated: boolean;
  otherUser: boolean;
  virtualDisplay: boolean;
  lastRun: { action: string; ok: boolean; message: string; at: string } | null;
  job: { kind: "install" | "uninstall"; state: "running" | "done" | "error"; message: string | null } | null;
}

export function describeHelper(status: HeadlessHelperStatus): string {
  if (status.job?.state === "running") {
    return status.job.kind === "install"
      ? "Waiting for the administrator prompt on the PC…"
      : "Removing — approve the administrator prompt on the PC…";
  }
  if (status.otherUser) return "Installed for another Windows user. Reinstall to use it from this account.";
  if (status.outdated) return "Installed by an older PPM. Reinstall to update it.";
  if (status.usable) {
    return status.virtualDisplay
      ? "Set up. From the Remote Desktop checklist PPM can bring your session back and turn on a virtual display."
      : "Set up. PPM can bring your session back from the Remote Desktop checklist.";
  }
  if (status.installed) return "Installed, but its tasks are missing. Reinstall to repair it.";
  return "Not set up.";
}

export function HeadlessHelperSection() {
  const [status, setStatus] = useState<HeadlessHelperStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setStatus(await api.get<HeadlessHelperStatus>("/api/remote-desktop/headless-helper")); }
    catch { setStatus(null); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const running = status?.job?.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [running, load]);

  const start = async (kind: "install" | "uninstall") => {
    setConfirming(false);
    setError(null);
    try { await api.post(`/api/remote-desktop/headless-helper/${kind}`); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    await load();
  };

  if (!status?.supported) return null;
  const jobFailed = status.job?.state === "error" ? status.job.message : null;

  return (
    <>
    <Separator />
    <section className="space-y-3" data-testid="headless-helper-section">
      <div>
        <h3 className="text-sm font-medium">Run without a monitor (Windows)</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          When a Remote Desktop (RDP) window closes, Windows leaves your session disconnected and draws nothing,
          so there is no picture to capture; with no monitor plugged in there is no screen at all. This helper lets
          PPM bring the session back to this PC&apos;s own screen and turn on a virtual display for the session, from
          the Remote Desktop checklist, without TeamViewer. Setting it up needs one administrator prompt on the PC.
        </p>
      </div>
      <p className="flex items-center gap-2 text-xs" data-testid="headless-helper-status">
        {running ? <Loader2 className="size-3.5 animate-spin" /> : status.usable ? <Check className="size-3.5 text-emerald-500" /> : null}
        {describeHelper(status)}
      </p>
      {(error || jobFailed) && <p role="alert" className="text-xs text-destructive">{error || jobFailed}</p>}
      <div className="flex flex-wrap gap-2">
        <Button className={TEXT_BUTTON} disabled={running} onClick={() => setConfirming(true)} data-testid="headless-helper-install">
          {status.installed ? "Reinstall" : "Set up"}
        </Button>
        {status.installed && (
          <Button variant="outline" className={TEXT_BUTTON} disabled={running} onClick={() => void start("uninstall")}>
            Remove
          </Button>
        )}
      </div>
      {confirming && <HeadlessHelperConfirm onConfirm={() => void start("install")} onCancel={() => setConfirming(false)} />}
    </section>
    </>
  );
}
