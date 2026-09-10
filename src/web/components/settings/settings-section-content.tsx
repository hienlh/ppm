/**
 * Maps a settings category to the component that fills the content pane.
 *
 * The only coupling point between the settings shell and the individual panes: adding a
 * category means adding an entry here plus one in `settings-categories.ts`, and neither the
 * rail, the stacked list, nor the window frame changes. Entries are lazy so opening Settings
 * does not pull every pane's dependencies (charts, editors, cron pickers) into the bundle.
 */

import { Suspense, lazy, type ComponentType, type LazyExoticComponent } from "react";
import { Loader2 } from "lucide-react";
import type { SettingsCategoryId } from "./settings-categories";

const SECTIONS: Record<SettingsCategoryId, LazyExoticComponent<ComponentType>> = {
  general: lazy(() => import("./general-settings-section").then((m) => ({ default: m.GeneralSettingsSection }))),
  appearance: lazy(() => import("./appearance-settings-section").then((m) => ({ default: m.AppearanceSettingsSection }))),
  "ai-provider": lazy(() => import("./ai-settings-section").then((m) => ({ default: m.AISettingsSection }))),
  accounts: lazy(() => import("./accounts/accounts-settings-section").then((m) => ({ default: m.AccountsSettingsSection }))),
  ppmbot: lazy(() => import("./ppmbot-settings-section").then((m) => ({ default: m.PPMBotSettingsSection }))),
  notifications: lazy(() => import("./notifications-settings-section").then((m) => ({ default: m.NotificationsSettingsSection }))),
  jira: lazy(() => import("./jira-watcher-section").then((m) => ({ default: m.JiraWatcherSection }))),
  extensions: lazy(() => import("./extension-manager-section").then((m) => ({ default: m.ExtensionManagerSection }))),
  proxy: lazy(() => import("./proxy-settings-section").then((m) => ({ default: m.ProxySettingsSection }))),
  schedules: lazy(() => import("./schedules/schedules-settings-section").then((m) => ({ default: m.SchedulesSettingsSection }))),
  shortcuts: lazy(() => import("./keyboard-shortcuts-section").then((m) => ({ default: m.KeyboardShortcutsSection }))),
  files: lazy(() => import("./files-settings-section").then((m) => ({ default: m.FilesSettingsSection }))),
  "query-audit": lazy(() => import("./query-audit-section").then((m) => ({ default: m.QueryAuditSection }))),
};

export function SettingsSectionContent({ category }: { category: SettingsCategoryId }) {
  const Section = SECTIONS[category];
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <Section />
    </Suspense>
  );
}
