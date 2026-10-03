import { useState } from "react";
import { toast } from "sonner";
import { Download, Loader2, Settings2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { cn } from "@/lib/utils";
import { installDbDriver, type MissingDbDriver } from "@/lib/db-drivers";
import { openSettings } from "@/components/settings/open-settings";

/**
 * Offered where a request came back `DB_DRIVER_MISSING`: the grid, a
 * connection's table list, the connection form. Pressing Install is the
 * consent the server waits for — nothing is downloaded until then. What
 * needed the driver runs again through `useDbDriverInstalled`, which also
 * hears an install made in Settings.
 */
export function DriverMissingNotice({ driver, compact = false, className }: {
  driver: MissingDbDriver;
  /** The narrow form for the sidebar tree. */
  compact?: boolean;
  className?: string;
}) {
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMobile = useIsMobile();

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      await installDbDriver(driver.id);
      toast.success(`Installed the ${driver.displayName} driver`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInstalling(false);
    }
  };

  const buttonSize = isMobile ? "min-h-11" : compact ? "h-7" : "h-8";

  return (
    <div
      role="status"
      data-testid="db-driver-missing"
      className={cn(compact ? "space-y-1.5 px-2 py-1.5" : "space-y-2 rounded-lg border border-border bg-muted/40 p-3", className)}
    >
      <p className={cn("font-medium", compact ? "text-[11px]" : "text-sm")}>
        The {driver.displayName} driver is not installed
      </p>
      <p className={cn("text-muted-foreground", compact ? "text-[10px]" : "text-xs")}>
        PPM downloads it once, at the release it was tested with, into its own folder.
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" onClick={install} disabled={installing} className={cn("gap-1 text-xs cursor-pointer", buttonSize)}>
          {installing ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />}
          {installing ? "Installing…" : "Install"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => openSettings("database-drivers")}
          className={cn("gap-1 text-xs text-muted-foreground cursor-pointer", buttonSize)}
        >
          <Settings2 className="size-3" />
          Settings
        </Button>
      </div>
      {error && <p className={cn("text-error break-words", compact ? "text-[10px]" : "text-xs")}>{error}</p>}
    </div>
  );
}
