import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { Loader2, ArrowUpCircle, X, RefreshCw, CheckCircle2 } from "lucide-react";

const POLL_INTERVAL_MS = 60_000;
const DISMISS_KEY_PREFIX = "ppm-upgrade-dismissed-";

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

/** Clear browser/SW caches and reload the page */
async function clearCachesAndReload() {
  if ("caches" in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  }
  window.location.reload();
}

interface UpgradeBannerProps {
  onVisibilityChange?: (visible: boolean) => void;
}

export function UpgradeBanner({ onVisibilityChange }: UpgradeBannerProps) {
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeComplete, setUpgradeComplete] = useState(false);
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
        // Upgrade installed, server will restart — ask user to reload
        setUpgrading(false);
        setUpgradeComplete(true);
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
      // If fetch failed with a network error, the server likely died mid-response
      // after the install succeeded (supervisor killed the server before response flushed).
      // Show reload prompt instead of a confusing error.
      const isNetworkError = e instanceof TypeError
        || (e as Error).message?.includes("fetch")
        || (e as Error).message?.includes("network");
      if (isNetworkError) {
        setUpgrading(false);
        setUpgradeComplete(true);
      } else {
        toast.error(`Upgrade failed: ${(e as Error).message}`);
        setUpgrading(false);
      }
    }
  }, [availableVersion]);

  const handleDismiss = useCallback(() => {
    if (availableVersion) {
      sessionStorage.setItem(DISMISS_KEY_PREFIX + availableVersion, "1");
    }
    setDismissed(true);
  }, [availableVersion]);

  const visible = (!!availableVersion && !dismissed) || upgradeComplete;

  useEffect(() => {
    onVisibilityChange?.(visible);
  }, [visible, onVisibilityChange]);

  if (!visible) return null;

  return (
    <div className={`w-full text-white px-3 py-1 flex items-center justify-between gap-2 z-50 text-sm shrink-0 ${
      upgradeComplete ? "bg-green-600 dark:bg-green-700" : "bg-blue-600 dark:bg-blue-700"
    }`}>
      {upgradeComplete ? (
        <>
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <CheckCircle2 className="size-4 shrink-0" />
            <span className="truncate">
              Upgrade to v{availableVersion} installed! Reload to apply.
            </span>
          </div>
          <button
            onClick={clearCachesAndReload}
            className="bg-white text-green-600 font-medium rounded-full px-3 py-0.5 text-xs min-h-[28px] min-w-[28px] flex items-center gap-1.5 justify-center hover:bg-green-50 active:bg-green-100 transition-colors shrink-0"
          >
            <RefreshCw className="size-3" />
            Reload
          </button>
        </>
      ) : upgrading ? (
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Loader2 className="size-4 animate-spin shrink-0" />
          <span className="truncate">
            Upgrading to v{availableVersion}...
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
