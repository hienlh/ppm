/**
 * The OAuth profile behind an account: who it belongs to, which organisation, which tier —
 * plus that account's usage history chart.
 *
 * Only the fields the server actually sent are rendered; a missing organisation is normal
 * for a personal account and should not leave labelled blanks on screen.
 */

import { X } from "lucide-react";
import type { OAuthProfileData } from "../../../lib/api-settings";
import { UsagePatternChart } from "./account-usage-pattern-chart";

export function AccountProfilePanel({ profile, accountId, onClose }: {
  profile: OAuthProfileData;
  accountId: string;
  onClose: () => void;
}) {
  const rows: [string, string | undefined][] = [
    ["Name", profile.account?.display_name],
    ["Email", profile.account?.email],
    ["Org", profile.organization?.name],
    ["Type", profile.organization?.organization_type],
    ["Tier", profile.organization?.rate_limit_tier],
    ["Status", profile.organization?.subscription_status],
  ];

  return (
    <section className="space-y-2 border-t border-border pt-3" data-testid="account-profile-panel">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Profile</h3>
        <button
          className="p-2 text-muted-foreground hover:text-foreground cursor-pointer"
          onClick={onClose}
          aria-label="Close profile"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1 text-xs">
        {rows.map(([label, value]) =>
          value ? (
            <span key={label} className="contents">
              <span className="text-muted-foreground">{label}</span>
              <span className="break-all">{value}</span>
            </span>
          ) : null,
        )}
      </div>
      <UsagePatternChart accountId={accountId} />
    </section>
  );
}
