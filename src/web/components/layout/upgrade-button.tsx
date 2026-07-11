import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { Loader2, ArrowUpCircle, RefreshCw, Download, ExternalLink } from "lucide-react";
import { useSettingsStore } from "@/stores/settings-store";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 60_000;
const DISMISS_KEY_PREFIX = "ppm-upgrade-dismissed-";
const RELEASES_URL = "https://github.com/hienlh/ppm/releases";

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

/**
 * Status-bar version chip. Shows the current version normally; when a new
 * release is available it turns into an accent "update" button that opens a
 * popover (Update now / Release notes / Later) — replaces the old top banner.
 */
export function UpgradeButton() {
  const version = useSettingsStore((s) => s.version);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [complete, setComplete] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;
    async function check() {
      try {
        const data = await api.get<UpgradeStatus>("/api/upgrade");
        setCurrentVersion(data.currentVersion);
        if (data.availableVersion) {
          setAvailableVersion(data.availableVersion);
          setDismissed(!!sessionStorage.getItem(DISMISS_KEY_PREFIX + data.availableVersion));
        } else {
          setAvailableVersion(null);
        }
      } catch {
        // ignore — chip just shows the known version
      }
    }
    check();
    timer = setInterval(check, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const handleUpgrade = useCallback(async () => {
    setUpgrading(true);
    setOpen(false);
    try {
      const data = await api.post<UpgradeResult>("/api/upgrade/apply");
      if (data.restart) {
        setUpgrading(false);
        setComplete(true);
      } else {
        toast.info(data.message || "Upgrade installed. Restart PPM manually.");
        setUpgrading(false);
        if (availableVersion) sessionStorage.setItem(DISMISS_KEY_PREFIX + availableVersion, "1");
        setDismissed(true);
      }
    } catch (e) {
      const isNetworkError = e instanceof TypeError
        || (e as Error).message?.includes("fetch")
        || (e as Error).message?.includes("network");
      if (isNetworkError) {
        setUpgrading(false);
        setComplete(true);
      } else {
        toast.error(`Upgrade failed: ${(e as Error).message}`);
        setUpgrading(false);
      }
    }
  }, [availableVersion]);

  const handleDismiss = useCallback(() => {
    if (availableVersion) sessionStorage.setItem(DISMISS_KEY_PREFIX + availableVersion, "1");
    setDismissed(true);
    setOpen(false);
  }, [availableVersion]);

  const current = currentVersion ?? version;
  const hasUpdate = !!availableVersion && !dismissed;

  if (!current && !hasUpdate) return null;

  // Upgrade finished — prompt reload.
  if (complete) {
    return (
      <button
        onClick={clearCachesAndReload}
        className="flex items-center gap-1 px-1 rounded-sm text-success hover:brightness-110 transition-[filter]"
        title="Reload to apply the update"
      >
        <RefreshCw className="size-3" /> Reload
      </button>
    );
  }

  if (upgrading) {
    return (
      <span className="flex items-center gap-1 px-1 text-success">
        <Loader2 className="size-3 animate-spin" /> Updating…
      </span>
    );
  }

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => hasUpdate && setOpen((v) => !v)}
        title={hasUpdate ? `Update available: v${availableVersion}` : `PPM v${current}`}
        className={cn(
          "flex items-center gap-1 px-1 rounded-sm transition-colors",
          hasUpdate ? "text-success hover:brightness-110" : "cursor-default",
        )}
      >
        {hasUpdate && <ArrowUpCircle className="size-3" />}
        {current && <span>v{current}</span>}
      </button>

      {open && hasUpdate && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full right-0 mb-2 w-72 z-50 rounded-[var(--rad-sm)] border border-border bg-panel-2 backdrop-blur-xl shadow-[var(--shadow-panel)] overflow-hidden font-sans">
            <div className="flex items-center gap-2.5 px-3 py-3 border-b border-border-soft">
              <span className="flex items-center justify-center size-[26px] shrink-0 rounded-lg bg-success/20">
                <ArrowUpCircle className="size-[15px] text-success" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-text leading-tight">Update available</div>
                <div className="text-[11px] text-text-3 font-mono mt-0.5">v{current} → v{availableVersion}</div>
              </div>
            </div>
            <p className="px-3 py-2.5 text-[12.5px] text-text-2 leading-relaxed">
              A new version of PPM is available. Update now, or review the release notes first.
            </p>
            <div className="flex flex-col gap-1.5 px-3 pb-3">
              <button
                onClick={handleUpgrade}
                className="flex items-center justify-center gap-1.5 w-full py-2 rounded-lg bg-success text-[12.5px] font-bold text-[#04130c] hover:brightness-105 transition-[filter]"
              >
                <Download className="size-3.5" /> Update now
              </button>
              <div className="flex gap-1.5">
                <a
                  href={RELEASES_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border border-border bg-panel text-xs font-medium text-text-2 hover:text-text transition-colors"
                >
                  <ExternalLink className="size-3" /> Release notes
                </a>
                <button
                  onClick={handleDismiss}
                  className="px-3 py-2 rounded-lg border border-border text-xs text-text-3 hover:text-text-2 transition-colors"
                >
                  Later
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
