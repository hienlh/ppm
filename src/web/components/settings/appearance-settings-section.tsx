/**
 * Appearance settings: the theme and the chrome choices that ride on top of it.
 *
 * Theme style and mode are separate axes — the grid picks the palette, the mode row overrides
 * light/dark within it, and System follows the OS.
 */

import { WrapText, Zap } from "@/lib/icons";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { useSettingsStore, type EditorTabStyle, type ExplorerSkinPref } from "@/stores/settings-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { cn } from "@/lib/utils";
import { THEME_MODE_OPTIONS } from "@/theme/theme-mode-options";
import { ThemeGrid } from "./theme-grid";
import { ThemeManagerSection } from "./theme-manager-section";

const TAB_STYLE_OPTIONS: { value: EditorTabStyle; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "boxed", label: "Boxed" },
  { value: "pill", label: "Pill" },
];

const EXPLORER_SKIN_OPTIONS: { value: ExplorerSkinPref; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "windows", label: "Windows" },
  { value: "macos", label: "macOS" },
];

/** Segmented row of mutually exclusive choices — same shape for tab style and explorer skin. */
function OptionRow<T extends string>({
  options, value, onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex gap-2">
      {options.map((opt) => (
        <Button
          key={opt.value}
          variant={value === opt.value ? "default" : "outline"}
          onClick={() => onChange(opt.value)}
          className={cn("flex-1 cursor-pointer", value === opt.value && "ring-2 ring-primary")}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  );
}

export function AppearanceSettingsSection() {
  const {
    theme, setTheme, tabWrap, toggleTabWrap, editorTabStyle, setEditorTabStyle, explorerSkin, setExplorerSkin,
  } = useSettingsStore(
    useShallow((s) => ({
      theme: s.themeMode,
      setTheme: s.setThemeMode,
      tabWrap: s.tabWrap,
      toggleTabWrap: s.toggleTabWrap,
      editorTabStyle: s.editorTabStyle,
      setEditorTabStyle: s.setEditorTabStyle,
      explorerSkin: s.explorerSkin,
      setExplorerSkin: s.setExplorerSkin,
    })),
  );
  const { wordWrap, toggleWordWrap, mobileWordWrap, toggleMobileWordWrap, lspEnabled, setLspEnabled } = useSettingsStore(
    useShallow((s) => ({
      wordWrap: s.wordWrap, toggleWordWrap: s.toggleWordWrap,
      mobileWordWrap: s.mobileWordWrap, toggleMobileWordWrap: s.toggleMobileWordWrap,
      lspEnabled: s.lspEnabled, setLspEnabled: s.setLspEnabled,
    })),
  );
  const isMobile = useIsMobile();

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-sm font-medium">Theme</h3>
        <ThemeGrid />
        <div className="flex gap-2">
          {THEME_MODE_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            return (
              <Button
                key={opt.value}
                variant={theme === opt.value ? "default" : "outline"}
                onClick={() => setTheme(opt.value)}
                className={cn("flex-1 gap-2 cursor-pointer", theme === opt.value && "ring-2 ring-primary")}
              >
                <Icon className="size-4" />
                {opt.label}
              </Button>
            );
          })}
        </div>
      </section>

      <Separator />

      <ThemeManagerSection />

      <Separator />

      <section className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <WrapText className="size-4 text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium">Wrap Tabs</p>
            <p className="text-xs text-muted-foreground">Stack tabs in rows instead of scrolling</p>
          </div>
        </div>
        <Switch checked={tabWrap} onCheckedChange={toggleTabWrap} />
      </section>

      {/* Word wrap in the editor. Two prefs behind one switch: a phone keeps its own
          answer (and defaults to wrapping) because the desktop one is shared across
          devices and a 6-inch screen cannot use "no wrap". */}
      <section className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <WrapText className="size-4 text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium">Word Wrap</p>
            <p className="text-xs text-muted-foreground">
              {isMobile
                ? "Wrap long lines instead of scrolling sideways (this device)"
                : "Wrap long lines in the editor (Alt+Z)"}
            </p>
          </div>
        </div>
        <Switch
          checked={isMobile ? mobileWordWrap : wordWrap}
          onCheckedChange={() => (isMobile ? toggleMobileWordWrap() : toggleWordWrap())}
        />
      </section>

      {/* Language server. Off until asked: it is a real process on the host (one was
          854 MB resident), and a phone never starts one. */}
      <section className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Zap className="size-4 text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium">Language Server</p>
            <p className="text-xs text-muted-foreground">
              {isMobile
                ? "Off on a phone — it runs a server process per project"
                : "Completions, hover, F12, rename and quick fix (this device)"}
            </p>
          </div>
        </div>
        <Switch checked={lspEnabled && !isMobile} disabled={isMobile} onCheckedChange={setLspEnabled} />
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Tab Style</h3>
        <OptionRow options={TAB_STYLE_OPTIONS} value={editorTabStyle} onChange={setEditorTabStyle} />
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Explorer Skin</h3>
        <p className="text-xs text-muted-foreground">
          Chrome the OS File Explorer window wears. Auto follows the host platform.
        </p>
        <OptionRow options={EXPLORER_SKIN_OPTIONS} value={explorerSkin} onChange={setExplorerSkin} />
      </section>
    </div>
  );
}
