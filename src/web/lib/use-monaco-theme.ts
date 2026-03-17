import { useEffect, useState } from "react";
import { useSettingsStore } from "@/stores/settings-store";

/** Resolves the current app theme to a Monaco editor theme name. */
export function useMonacoTheme(): string {
  const theme = useSettingsStore((s) => s.theme);

  const resolve = () => {
    if (theme === "dark") return "vs-dark";
    if (theme === "light") return "light";
    // system
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "vs-dark" : "light";
  };

  const [monacoTheme, setMonacoTheme] = useState(resolve);

  useEffect(() => {
    setMonacoTheme(resolve());

    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => setMonacoTheme(mq.matches ? "vs-dark" : "light");
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, [theme]);

  return monacoTheme;
}
