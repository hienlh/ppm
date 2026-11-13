import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { C, fail, run } from "./chat-cmd-request.ts";
import { settingsRequest } from "../utils/settings-request.ts";

/**
 * `ppm theme` — the app's theme and the imported themes, through the routes Settings → Appearance
 * calls, so every open PPM re-themes at once. A theme is a built-in style (aurora, slate,
 * precision) or an imported theme's id (`custom-…`, see `ppm theme list`).
 */

type ThemeMode = "light" | "dark" | "system";
type ThemeConfig = { style: string; mode: ThemeMode; customThemeId?: string };
type ImportedTheme = { id: string; name: string; mode: "dark" | "light" };

/** The built-in styles, as the web app's theme registry names them. */
const BUILTIN_STYLES = ["aurora", "slate", "precision"] as const;
const MODES: readonly ThemeMode[] = ["light", "dark", "system"];

const describe = (t: ThemeConfig) => `${t.style === "custom" ? t.customThemeId ?? "custom" : t.style} (${t.mode})`;

async function currentTheme(): Promise<ThemeConfig> {
  return (await settingsRequest<{ theme: ThemeConfig }>("GET", "/theme")).theme;
}

/** The theme `name` stands for: a built-in style, or an imported theme by id or (case-blind) name. */
async function themeFor(name: string, mode: ThemeMode): Promise<ThemeConfig> {
  if ((BUILTIN_STYLES as readonly string[]).includes(name)) return { style: name, mode };
  const imported = await settingsRequest<ImportedTheme[]>("GET", "/themes");
  const found = imported.find((t) => t.id === name) ?? imported.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (!found) fail(`No theme "${name}". Built-in: ${BUILTIN_STYLES.join(", ")}; imported: see \`ppm theme list\``);
  return { style: "custom", mode, customThemeId: found!.id };
}

export function registerThemeCommands(program: Command): void {
  const theme = program.command("theme").description("Show, pick, import or remove PPM's themes");

  theme
    .command("get")
    .description("Show the theme in use")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => run(async () => {
      const t = await currentTheme();
      console.log(opts.json ? JSON.stringify(t, null, 2) : describe(t));
    })());

  theme
    .command("set <theme>")
    .description("Use a theme: aurora, slate, precision, or an imported theme's id or name")
    .option("--mode <mode>", "light, dark or system (default: keep the current one)")
    .action((name: string, opts: { mode?: string }) => run(async () => {
      if (opts.mode !== undefined && !MODES.includes(opts.mode as ThemeMode)) fail(`--mode must be one of: ${MODES.join(", ")}`);
      const mode = (opts.mode as ThemeMode | undefined) ?? (await currentTheme()).mode;
      const saved = await settingsRequest<{ theme: ThemeConfig }>("PUT", "/theme", await themeFor(name, mode));
      console.log(`${C.green}Theme:${C.reset} ${describe(saved.theme)}`);
    })());

  theme
    .command("list")
    .description("List the built-in styles and the imported themes")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => run(async () => {
      const imported = await settingsRequest<ImportedTheme[]>("GET", "/themes");
      if (opts.json) {
        console.log(JSON.stringify({ builtin: BUILTIN_STYLES, imported: imported.map(({ id, name, mode }) => ({ id, name, mode })) }, null, 2));
        return;
      }
      console.log(`Built-in: ${BUILTIN_STYLES.join(", ")} (each in light, dark or system)`);
      if (imported.length === 0) console.log(`${C.dim}No imported themes.${C.reset}`);
      for (const t of imported) console.log(`${t.id}  ${t.name}  ${C.dim}${t.mode}${C.reset}`);
    })());

  theme
    .command("import <fileOrUrl>")
    .description("Import a VS Code color theme from a JSON file, or from a URL (JSON or .vsix)")
    .option("--name <name>", "Name to show it under")
    .action((source: string, opts: { name?: string }) => run(async () => {
      const isUrl = /^https?:\/\//i.test(source);
      const value = isUrl ? source : readFileSync(resolve(source), "utf8");
      const { themes } = await settingsRequest<{ themes: ImportedTheme[] }>("POST", "/themes", {
        source: isUrl ? "url" : "upload", value, ...(opts.name ? { name: opts.name } : {}),
      }, { timeoutMs: 60_000 });
      for (const t of themes) console.log(`${C.green}Imported:${C.reset} ${t.id}  ${t.name} (${t.mode})`);
    })());

  theme
    .command("remove <id>")
    .description("Delete an imported theme")
    .action((id: string) => run(async () => {
      await settingsRequest("DELETE", `/themes/${encodeURIComponent(id)}`);
      console.log(`${C.green}Removed:${C.reset} ${id}`);
    })());

  theme
    .command("rename <id> <name>")
    .description("Rename an imported theme")
    .action((id: string, name: string) => run(async () => {
      const t = await settingsRequest<ImportedTheme>("PATCH", `/themes/${encodeURIComponent(id)}`, { name });
      console.log(`${C.green}Renamed:${C.reset} ${t.id} → ${t.name}`);
    })());
}
