import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { Loader2, ArrowUpCircle, RefreshCw, Download, ExternalLink, History } from "lucide-react";
import { useSettingsStore } from "@/stores/settings-store";
import { fetchChangelogSince, fetchRecentChangelog, compareSemver, type ChangelogSection } from "@/lib/changelog";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 60_000;
const DISMISS_KEY_PREFIX = "ppm-upgrade-dismissed-";
const RELEASES_URL = "https://github.com/hienlh/ppm/releases";

// QA test hook. `?ppm_upgrade_test[=<ver|off>]` forces the update state on dev.
// The flag is latched into sessionStorage at module load — BEFORE useUrlSync
// rewrites the URL and drops the param — so it survives tab/project navigation
// and reloads. Clear it with `?ppm_upgrade_test=off`.
const TEST_KEY = "ppm-upgrade-test";
(function latchTestMode() {
  if (typeof window === "undefined") return;
  const p = new URLSearchParams(window.location.search);
  if (!p.has("ppm_upgrade_test")) return;
  const v = p.get("ppm_upgrade_test");
  if (v === "off" || v === "0" || v === "false") sessionStorage.removeItem(TEST_KEY);
  else sessionStorage.setItem(TEST_KEY, v || "1");
})();

/** Latched test target: null = off, "" = auto (next minor), else a version string. */
function getTestTarget(): string | null {
  if (typeof window === "undefined") return null;
  const v = sessionStorage.getItem(TEST_KEY);
  if (v === null) return null;
  return v === "1" ? "" : v;
}

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

/** Bump the minor version (for the QA test hook's synthetic target). */
function nextMinor(v: string): string {
  const [maj = 0, min = 0] = v.split(".").map((n) => parseInt(n, 10) || 0);
  return `${maj}.${min + 1}.0`;
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
 * Wait until the upgraded server is listening again before reloading.
 * The upgrade signals the supervisor to kill + reboot the server, so an
 * immediate reload would navigate the SPA away onto a dead server and land on
 * the browser's error page — with no JS left to auto-recover. Poll /api/health
 * until it responds (or we give up), THEN clear caches and reload.
 */
async function reloadWhenServerReady() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (res.ok) break;
    } catch {
      // server still restarting
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  await clearCachesAndReload();
}

/**
 * Status-bar version chip. Shows the current version normally; when a new
 * release is available it turns into an accent "update" button that opens a
 * popover (Update now / Release notes / Later) — replaces the old top banner.
 */
export function UpgradeButton({ align = "right" }: { align?: "left" | "right" }) {
  const version = useSettingsStore((s) => s.version);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [complete, setComplete] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [notes, setNotes] = useState<ChangelogSection[] | null>(null);
  const [notesLoading, setNotesLoading] = useState(false);

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

  const current = currentVersion ?? version;
  // QA hook (latched in sessionStorage — see getTestTarget). Forces the update
  // state on dev; `Update now` becomes a no-op. Off in normal use.
  const latchedTarget = getTestTarget();
  const isTest = latchedTarget !== null;
  const testTarget = latchedTarget || (current ? nextMinor(current) : "9.9.9");
  // Only a strictly-newer version counts as an update (guards against the
  // upgrade check reporting an equal/older version — e.g. a stale registry).
  const realUpdate = !!availableVersion && !!current && compareSemver(availableVersion, current) > 0
    ? availableVersion
    : null;
  const effectiveAvailable = realUpdate ?? (isTest ? testTarget : null);
  const hasUpdate = !!effectiveAvailable && !dismissed;

  // Load release notes each time the popover opens. Refetching (not caching for
  // the session) avoids latching a stale/empty result from a transient fetch:
  // the changelog source can briefly lag the version signal after a release.
  useEffect(() => {
    if (!open || !current) return;
    setNotesLoading(true);
    // Update mode → sections newer than installed (test hook shows all).
    // No update → recent releases so clicking the version chip still shows notes.
    const load = hasUpdate
      ? fetchChangelogSince(isTest ? "0.0.0" : current)
      : fetchRecentChangelog();
    load
      .then(setNotes)
      .catch(() => setNotes([]))
      .finally(() => setNotesLoading(false));
  }, [open, current, hasUpdate, isTest]);

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

  if (!current && !hasUpdate) return null;

  // Upgrade finished — prompt reload. Wait for the server to finish restarting
  // before navigating, so we don't reload onto a dead server.
  if (complete) {
    return (
      <button
        onClick={() => { setReloading(true); reloadWhenServerReady(); }}
        disabled={reloading}
        className="flex items-center gap-1 px-1 rounded-sm text-success hover:brightness-110 transition-[filter] disabled:opacity-70"
        title={reloading ? "Waiting for the server to restart…" : "Reload to apply the update"}
      >
        {reloading
          ? <><Loader2 className="size-3 animate-spin" /> Waiting for server…</>
          : <><RefreshCw className="size-3" /> Reload</>}
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
        onClick={() => current && setOpen((v) => !v)}
        title={hasUpdate ? `Update available: v${effectiveAvailable}` : `PPM v${current} — release notes`}
        className={cn(
          "flex items-center gap-1 px-1 rounded-sm transition-colors",
          hasUpdate ? "text-success hover:brightness-110" : "hover:text-text",
        )}
      >
        {hasUpdate && <ArrowUpCircle className="size-3" />}
        <span>{hasUpdate ? `New version · v${effectiveAvailable}` : `v${current}`}</span>
      </button>

      {open && current && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className={cn(
            "absolute bottom-full mb-2 w-72 z-50 rounded-[var(--rad-sm)] border border-border popover-solid shadow-[var(--shadow-panel)] overflow-hidden font-sans",
            align === "left" ? "left-0" : "right-0",
          )}>
            <div className="flex items-center gap-2.5 px-3 py-3 border-b border-border-soft">
              <span className={cn(
                "flex items-center justify-center size-[26px] shrink-0 rounded-lg",
                hasUpdate ? "bg-success/20" : "bg-accent/15",
              )}>
                {hasUpdate
                  ? <ArrowUpCircle className="size-[15px] text-success" />
                  : <History className="size-[15px] text-accent" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-text leading-tight">
                  {hasUpdate ? "Update available" : "Release notes"}
                </div>
                <div className="text-[11px] text-text-3 font-mono mt-0.5">
                  {hasUpdate ? `v${current} → v${effectiveAvailable}` : `PPM v${current}`}
                </div>
              </div>
            </div>
            <div className="max-h-56 overflow-y-auto overflow-x-hidden px-3 py-2.5 text-[12px] text-text-2 leading-relaxed break-words">
              {notesLoading ? (
                <span className="flex items-center gap-2 text-text-3">
                  <Loader2 className="size-3.5 animate-spin" /> Loading release notes…
                </span>
              ) : notes && notes.length > 0 ? (
                <div className="space-y-2.5">
                  {notes.map((s) => (
                    <ChangelogEntry key={s.version} version={s.version} body={s.body} />
                  ))}
                </div>
              ) : (
                <span className="text-text-3">
                  {hasUpdate
                    ? "A new version of PPM is available. Open the release notes for details."
                    : "No release notes available right now."}
                </span>
              )}
            </div>
            <div className="flex flex-col gap-1.5 px-3 pb-3">
              {hasUpdate && (
                <button
                  onClick={isTest && !realUpdate
                    ? () => { toast.info("Test mode — no real update to install"); setOpen(false); }
                    : handleUpgrade}
                  className="flex items-center justify-center gap-1.5 w-full py-2 rounded-lg bg-success text-[12.5px] font-bold text-[#04130c] hover:brightness-105 transition-[filter]"
                >
                  <Download className="size-3.5" /> Update now
                </button>
              )}
              <div className="flex gap-1.5">
                <a
                  href={RELEASES_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border border-border bg-panel text-xs font-medium text-text-2 hover:text-text transition-colors"
                >
                  <ExternalLink className="size-3" /> Release notes
                </a>
                {hasUpdate && (
                  <button
                    onClick={handleDismiss}
                    className="px-3 py-2 rounded-lg border border-border text-xs text-text-3 hover:text-text-2 transition-colors"
                  >
                    Later
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Strip inline markdown emphasis/code so the changelog reads cleanly in the popover. */
function stripInline(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
}

/** Render one CHANGELOG version section: version heading + category headings + bullets. */
function ChangelogEntry({ version, body }: { version: string; body: string }) {
  const lines = body.split("\n");
  return (
    <div>
      <div className="text-[11px] font-mono font-semibold text-text mb-1">v{version}</div>
      <div className="space-y-1">
        {lines.map((line, i) => {
          const t = line.trim();
          if (!t) return null;
          if (t.startsWith("### ")) {
            return (
              <div key={i} className="text-[10px] font-semibold uppercase tracking-wide text-text-3 pt-1">
                {t.slice(4)}
              </div>
            );
          }
          if (t.startsWith("- ")) {
            return (
              <div key={i} className="flex gap-1.5 text-text-2">
                <span className="text-text-3 shrink-0">•</span>
                <span className="min-w-0 break-words">{stripInline(t.slice(2))}</span>
              </div>
            );
          }
          return <div key={i} className="text-text-2 break-words">{stripInline(t)}</div>;
        })}
      </div>
    </div>
  );
}
