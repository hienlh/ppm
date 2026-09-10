/**
 * Notification settings.
 *
 * Browser push is not wired up yet, so this pane's job is to say so plainly and point at
 * PPMBot, which is where alerts actually get delivered today.
 */

import { Bell } from "lucide-react";
import { Separator } from "@/components/ui/separator";

export function NotificationsSettingsSection() {
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Push Notifications</h3>
        <div className="flex items-center gap-2">
          <Bell className="size-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Not available yet</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Browser push does not deliver right now. Use Telegram below to get alerted when a
          session finishes or needs approval.
        </p>
      </section>

      <Separator />

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Telegram</h3>
        <p className="text-xs text-muted-foreground">
          Telegram notifications are sent to all approved devices in PPMBot settings. Configure
          your bot token and pair devices there.
        </p>
      </section>
    </div>
  );
}
