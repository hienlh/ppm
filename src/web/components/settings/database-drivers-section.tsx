/**
 * Database drivers, installed on request.
 *
 * PostgreSQL and SQLite are built in. Every other engine's driver, and the SSH client tunnels use,
 * is an npm package only the people using it need, so PPM does not ship it: pressing Install here — or on the
 * notice a connection shows when its driver is missing — downloads the release PPM was tested
 * with, every package checked against the digest recorded for it, into PPM's own folder.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Download, ExternalLink, Loader2, RefreshCw, Trash2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useDbDriverInstalled } from "@/hooks/use-db-driver-installed";
import { installDbDriver, listDbDrivers, removeDbDriver } from "@/lib/db-drivers";
import type { DbDriverStatus } from "../../../shared/db-drivers";

export function DatabaseDriversSection() {
  const [drivers, setDrivers] = useState<DbDriverStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<DbDriverStatus | null>(null);
  const isMobile = useIsMobile();

  const load = useCallback(async () => {
    try {
      setDrivers(await listDbDrivers());
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  // Installed from a connection's notice while this pane is open.
  useDbDriverInstalled(() => { load(); });

  // An install another tab started is still running on the server: follow it until it ends.
  const serverBusy = drivers?.some((d) => d.installing || d.removing) ?? false;
  useEffect(() => {
    if (!serverBusy || busyId) return;
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [serverBusy, busyId, load]);

  const install = async (driver: DbDriverStatus) => {
    setBusyId(driver.id);
    try {
      await installDbDriver(driver.id);
      toast.success(`Installed the ${driver.displayName} driver`);
    } catch (e) {
      toast.error(`Could not install the ${driver.displayName} driver`, { description: (e as Error).message });
    } finally {
      setBusyId(null);
      await load();
    }
  };

  const remove = async (driver: DbDriverStatus) => {
    setConfirming(null);
    setBusyId(driver.id);
    try {
      await removeDbDriver(driver.id);
      toast.success(`Removed the ${driver.displayName} driver`);
    } catch (e) {
      toast.error(`Could not remove the ${driver.displayName} driver`, { description: (e as Error).message });
    } finally {
      setBusyId(null);
      await load();
    }
  };

  if (!drivers && !loadError) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">Drivers</h3>
        <p className="text-[11px] text-muted-foreground">
          PostgreSQL and SQLite are built in. Other databases need a driver, which PPM downloads
          when you press Install: the exact release PPM was tested with, every package checked
          against the digest recorded for it, into PPM&apos;s own folder. Nothing you installed
          yourself is used or changed, and Remove deletes exactly that folder.
        </p>

        {loadError && <p className="text-xs text-error">{loadError}</p>}

        <div className="space-y-1">
          {(drivers ?? []).map((driver) => (
            <DriverRow
              key={driver.id}
              driver={driver}
              working={busyId === driver.id || driver.installing || driver.removing}
              disabled={busyId !== null}
              isMobile={isMobile}
              onInstall={() => install(driver)}
              onRemove={() => setConfirming(driver)}
            />
          ))}
        </div>
      </section>

      {confirming && (
        <RemoveDriverConfirm driver={confirming} onConfirm={() => remove(confirming)} onCancel={() => setConfirming(null)} />
      )}
    </div>
  );
}

function DriverRow({ driver, working, disabled, isMobile, onInstall, onRemove }: {
  driver: DbDriverStatus;
  working: boolean;
  disabled: boolean;
  isMobile: boolean;
  onInstall: () => void;
  onRemove: () => void;
}) {
  const target = isMobile ? "min-h-11" : "h-8";
  const removing = working && driver.removing;

  return (
    <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-muted/50" data-testid={`db-driver-${driver.id}`}>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium truncate">{driver.displayName}</p>
        <p className="text-[11px] text-muted-foreground truncate">
          {sentenceCase(driver.usedFor)} ·{" "}
          <a
            href={driver.homepage}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 hover:text-foreground"
          >
            {driver.package} {driver.version}
            <ExternalLink className="size-2.5" />
          </a>{" "}
          · {driver.license}
        </p>
        {driver.state === "outdated" && driver.installed && (
          <p className="text-[11px] text-warning">
            {driver.installed.version} is installed; this PPM was tested with {driver.version}.
          </p>
        )}
      </div>

      {driver.state === "missing" ? (
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || working}
          onClick={onInstall}
          className={`text-xs px-3 gap-1 cursor-pointer shrink-0 ${target}`}
        >
          {working ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />}
          {working ? "Installing…" : "Install"}
        </Button>
      ) : (
        <div className="flex items-center gap-1 shrink-0">
          {driver.state === "outdated" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || working}
              onClick={onInstall}
              className={`text-xs px-3 gap-1 cursor-pointer ${target}`}
            >
              {working && !removing ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              Update
            </Button>
          ) : (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Check className="size-3.5 text-success" />
              {driver.installed ? formatBytes(driver.installed.bytes) : "Installed"}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            disabled={disabled || working}
            onClick={onRemove}
            title={`Remove the ${driver.displayName} driver`}
            aria-label={`Remove the ${driver.displayName} driver`}
            className={`text-error cursor-pointer ${isMobile ? "size-11" : "size-8"}`}
          >
            {removing ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Bottom sheet below `md`, centered dialog above — the same shell the language servers pane uses. */
function RemoveDriverConfirm({ driver, onConfirm, onCancel }: {
  driver: DbDriverStatus;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const isMobile = useIsMobile();
  const title = `Remove the ${driver.displayName} driver`;

  const body = (
    <div className="space-y-4" data-testid="db-driver-remove-confirm">
      <p className="text-sm text-muted-foreground">
        Open {driver.usedFor} close now, and none can connect until the driver is installed
        again. Saved connections stay.
      </p>
      <div className="flex flex-col-reverse md:flex-row gap-2 md:justify-end pt-2">
        <Button variant="outline" onClick={onCancel} className="min-h-11 cursor-pointer">Cancel</Button>
        <Button variant="destructive" onClick={onConfirm} className="min-h-11 cursor-pointer">Remove</Button>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <BottomSheet open onClose={onCancel}>
        <div className="px-4 pb-4">
          <h2 className="text-base font-semibold mb-3">{title}</h2>
          {body}
        </div>
      </BottomSheet>
    );
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
