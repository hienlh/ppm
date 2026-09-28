/**
 * Maps a settings category to the component that fills the content pane.
 *
 * The only coupling point between the settings shell and the individual panes: adding a
 * category means adding an entry here plus one in `settings-categories.ts`, and neither the
 * rail, the stacked list, nor the window frame changes. Entries are lazy so opening Settings
 * does not pull every pane's dependencies (charts, editors, cron pickers) into the bundle.
 */

import { Suspense } from "react";
import { lazyWithPreload, type PreloadableComponent } from "@/lib/lazy-with-preload";
import { Loader2 } from "@/lib/icons";
import type { SettingsCategoryId } from "./settings-categories";

export const SECTIONS: Record<SettingsCategoryId, PreloadableComponent<object>> = {
  general: lazyWithPreload(() => import("./general-settings-section").then((m) => ({ default: m.GeneralSettingsSection }))),
  appearance: lazyWithPreload(() => import("./appearance-settings-section").then((m) => ({ default: m.AppearanceSettingsSection }))),
  "language-servers": lazyWithPreload(() => import("./language-servers-section").then((m) => ({ default: m.LanguageServersSection }))),
  "ai-provider": lazyWithPreload(() => import("./ai-settings-section").then((m) => ({ default: m.AISettingsSection }))),
  accounts: lazyWithPreload(() => import("./accounts/accounts-settings-section").then((m) => ({ default: m.AccountsSettingsSection }))),
  voice: lazyWithPreload(() => import("./voice-settings-section").then((m) => ({ default: m.VoiceSettingsSection }))),
  ppmbot: lazyWithPreload(() => import("./ppmbot-settings-section").then((m) => ({ default: m.PPMBotSettingsSection }))),
  notifications: lazyWithPreload(() => import("./notifications-settings-section").then((m) => ({ default: m.NotificationsSettingsSection }))),
  jira: lazyWithPreload(() => import("./jira-watcher-section").then((m) => ({ default: m.JiraWatcherSection }))),
  extensions: lazyWithPreload(() => import("./extension-manager-section").then((m) => ({ default: m.ExtensionManagerSection }))),
  proxy: lazyWithPreload(() => import("./proxy-settings-section").then((m) => ({ default: m.ProxySettingsSection }))),
  schedules: lazyWithPreload(() => import("./schedules/schedules-settings-section").then((m) => ({ default: m.SchedulesSettingsSection }))),
  shortcuts: lazyWithPreload(() => import("./keyboard-shortcuts-section").then((m) => ({ default: m.KeyboardShortcutsSection }))),
  files: lazyWithPreload(() => import("./files-settings-section").then((m) => ({ default: m.FilesSettingsSection }))),
  "query-audit": lazyWithPreload(() => import("./query-audit-section").then((m) => ({ default: m.QueryAuditSection }))),
};

/** Load every pane's code, so that opening Settings shows its pane without a spinner. */
export function preloadSettingsSections(): Promise<unknown> {
  return Promise.all(Object.values(SECTIONS).map((section) => section.preload()));
}

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
