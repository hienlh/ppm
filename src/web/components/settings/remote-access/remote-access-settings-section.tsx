/**
 * Settings → Remote Access: every way to open PPM itself from another device. One sub-tab each:
 *
 * - Tailscale: a private address on the tailnet (its own pane, unchanged).
 * - Public link: PPM's own Cloudflare tunnel, a public https address.
 *
 * Forwarding a dev server is not here: it is used far more often than either of these is set
 * up, so it stays a sidebar panel (`tunnels/port-forwarding-panel.tsx`), whose Set up and
 * Manage buttons land on these sub-tabs.
 */
import { cn } from "@/lib/utils";
import { TailscaleSettingsSection } from "../tailscale/tailscale-settings-section";
import { PublicLinkPane } from "./public-link-pane";
import { REMOTE_ACCESS_TABS, useRemoteAccessTab } from "./remote-access-tab-store";

export function RemoteAccessSettingsSection() {
  const tab = useRemoteAccessTab((s) => s.tab);
  const setTab = useRemoteAccessTab((s) => s.setTab);

  return (
    <div className="space-y-5" data-testid="remote-access" data-tab={tab}>
      <div role="tablist" aria-label="Remote access" className="flex gap-1 overflow-x-auto border-b border-border/50">
        {REMOTE_ACCESS_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            data-testid={`remote-access-tab-${t.id}`}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex min-h-11 shrink-0 cursor-pointer items-center whitespace-nowrap rounded-t px-3 text-sm transition-colors md:min-h-9 md:text-xs",
              tab === t.id
                ? "border-b-2 border-primary font-medium text-primary"
                : "text-text-subtle hover:text-text-secondary",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === "tailscale" && <TailscaleSettingsSection />}
        {tab === "public-link" && <PublicLinkPane />}
      </div>
    </div>
  );
}
