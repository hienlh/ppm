import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { Loader2, ArrowUpCircle, X } from "lucide-react";

const POLL_INTERVAL_MS = 60_000;
const DISMISS_KEY_PREFIX = "ppm-upgrade-dismissed-";
const RESTART_POLL_MS = 1_500;
const RESTART_TIMEOUT_MS = 60_000;

interface UpgradeStatus {
  currentVersion: string;
  availableVersion: string | null;
  installMethod: string;
}

interface UpgradeResult {
  success: boolean;
  newVersion?: string;
  restart: boolean;
  message?: string;
}

/** Poll /api/health aggressively until server goes down then back up, then reload. */
async function waitForServerRestart(): Promise<boolean> {
  let serverWentDown = false;
  const start = Date.now();

  while (Date.now() - start < RESTART_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, RESTART_POLL_MS));
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (res.ok && serverWentDown) {
        if ("caches" in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        }
        window.location.reload();
        return true;
      }
    } catch {
      serverWentDown = true;
    }
  }
  return false;
}

interface UpgradeBannerProps {
  onVisibilityChange?: (visible: boolean) => void;
}

export function UpgradeBanner({ onVisibilityChange }: UpgradeBannerProps) {
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Poll for upgrade status
  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;

    async function check() {
      try {
        const data = await api.get<UpgradeStatus>("/api/upgrade");
        if (data.availableVersion) {
          setAvailableVersion(data.availableVersion);
          // Check if this version was dismissed
          const key = DISMISS_KEY_PREFIX + data.availableVersion;
          if (sessionStorage.getItem(key)) setDismissed(true);
          else setDismissed(false);
        } else {
          setAvailableVersion(null);
        }
      } catch {
        // Silently ignore — don't show broken banner
      }
    }

    check();
    timer = setInterval(check, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const handleUpgrade = useCallback(async () => {
    setUpgrading(true);
    try {
      const data = await api.post<UpgradeResult>("/api/upgrade/apply");

      if (data.restart) {
        // Server will restart — poll aggressively until it comes back
        const restarted = await waitForServerRestart();
        if (!restarted) {
          toast.warning("Upgrade installed but server hasn't restarted. Try refreshing manually.");
          setUpgrading(false);
        }
      } else {
        // No supervisor — manual restart needed
        toast.info(data.message || "Upgrade installed. Restart PPM manually.");
        setUpgrading(false);
        if (availableVersion) {
          sessionStorage.setItem(DISMISS_KEY_PREFIX + availableVersion, "1");
        }
        setDismissed(true);
      }
    } catch (e) {
      toast.error(`Upgrade failed: ${(e as Error).message}`);
      setUpgrading(false);
    }
  }, []);

  const handleDismiss = useCallback(() => {
    if (availableVersion) {
      sessionStorage.setItem(DISMISS_KEY_PREFIX + availableVersion, "1");
    }
    setDismissed(true);
  }, [availableVersion]);

  const visible = !!availableVersion && !dismissed;

  useEffect(() => {
    onVisibilityChange?.(visible);
  }, [visible, onVisibilityChange]);

  if (!visible) return null;

  return (
    <div className="w-full bg-blue-600 dark:bg-blue-700 text-white px-3 py-1 flex items-center justify-between gap-2 z-50 text-sm shrink-0">
      {upgrading ? (
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Loader2 className="size-4 animate-spin shrink-0" />
          <span className="truncate">
            Upgrading to v{availableVersion}... PPM will restart shortly
          </span>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <ArrowUpCircle className="size-4 shrink-0" />
            <span className="truncate">
              PPM v{availableVersion} available
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={handleUpgrade}
              className="bg-white text-blue-600 font-medium rounded-full px-3 py-0.5 text-xs min-h-[28px] min-w-[28px] flex items-center justify-center hover:bg-blue-50 active:bg-blue-100 transition-colors"
            >
              Upgrade
            </button>
            <button
              onClick={handleDismiss}
              className="min-h-[28px] min-w-[28px] flex items-center justify-center rounded-full hover:bg-blue-500 active:bg-blue-800 transition-colors"
              aria-label="Dismiss upgrade notification"
            >
              <X className="size-4" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
