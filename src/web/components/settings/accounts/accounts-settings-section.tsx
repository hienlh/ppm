/**
 * Accounts pane: every provider's sign-ins in one place, one sub-tab each.
 *
 * Claude and Codex accounts have nothing in common underneath — separate endpoints
 * (`/api/accounts/*` vs `/api/codex-accounts/*`), separate login flows (paste-a-code OAuth
 * vs device code), separate rotation models (per-account settings vs a global strategy). So
 * they stay separate panes rather than being forced into one list; what they share is the
 * question the user came here to answer, which is "which accounts does PPM have?".
 *
 * A provider's tab only appears when that provider is configured. Only Claude ships in the
 * default config, so a fresh install would otherwise offer a Codex tab for something the
 * user never set up.
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { ProviderBadge } from "@/components/chat/provider-selector";
import { getAISettings } from "../../../lib/api-settings";
import { ClaudeAccountsSection } from "./claude-accounts-section";
import { CodexAccountsSection } from "./codex-accounts-section";

/** Providers with an account manager, in tab order. Others have no credentials to manage. */
const PROVIDER_TABS = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
] as const;

type ProviderTabId = (typeof PROVIDER_TABS)[number]["id"];

export function AccountsSettingsSection() {
  // Claude is always present, so it is a safe first paint while the provider list loads —
  // no spinner for the common case, and no tab bar flash when Codex turns out to be absent.
  const [configured, setConfigured] = useState<Set<string> | null>(null);
  const [active, setActive] = useState<ProviderTabId>("claude");

  useEffect(() => {
    let cancelled = false;
    getAISettings()
      .then((s) => { if (!cancelled) setConfigured(new Set(Object.keys(s.providers ?? {}))); })
      // A failed lookup must not hide Claude accounts — fall back to Claude only.
      .catch(() => { if (!cancelled) setConfigured(new Set(["claude"])); });
    return () => { cancelled = true; };
  }, []);

  const tabs = PROVIDER_TABS.filter((t) => t.id === "claude" || configured?.has(t.id));
  const showTabBar = tabs.length > 1;

  return (
    <div className="space-y-4" data-testid="accounts-pane" data-provider={active}>
      {showTabBar && (
        <div className="flex gap-1 border-b border-border/50">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActive(tab.id)}
              data-testid={`accounts-tab-${tab.id}`}
              aria-current={active === tab.id ? "page" : undefined}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs rounded-t transition-colors cursor-pointer ${
                active === tab.id
                  ? "text-primary border-b-2 border-primary font-medium"
                  : "text-text-subtle hover:text-text-secondary"
              }`}
            >
              <ProviderBadge providerId={tab.id} />
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {configured === null && !showTabBar && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Checking configured providers...
        </div>
      )}

      {active === "claude" ? <ClaudeAccountsSection /> : <CodexAccountsSection />}
    </div>
  );
}
