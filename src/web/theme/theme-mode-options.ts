import { Sun, Moon, Monitor } from "lucide-react";
import type { PpmThemeMode } from "./types";

/**
 * The three selectable theme modes, in display order. Shared by every mode
 * picker (settings tab, login screen) so the labels and icons cannot drift
 * apart between them.
 */
export const THEME_MODE_OPTIONS: {
  value: PpmThemeMode;
  label: string;
  icon: React.ElementType;
}[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];
