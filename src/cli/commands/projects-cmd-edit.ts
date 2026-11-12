import type { Command } from "commander";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { C, fail, projectSub, projectsRequest, refuseFolderFromAiChat } from "./projects-cmd-request.ts";

/**
 * `ppm projects` commands that change one registered project — rename, move, colour, icon,
 * order, clone, per-project settings. Each calls the route PPM's own screens call
 * (`projects-cmd-request.ts`), so the checks are the server's and every open PPM updates at once.
 */

type Project = { name: string; path: string; color?: string; image?: string };

const HEX_COLOR = /^#?[0-9a-fA-F]{6}$/;
const MAX_ICON_BYTES = 2_000_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;

/** The image kinds a browser shows as a project's icon, told apart by their first bytes. */
function imageKind(bytes: Uint8Array): string | null {
  const ascii = (from: number, n: number) => String.fromCharCode(...bytes.subarray(from, from + n));
  if (bytes[0] === 0x89 && ascii(1, 3) === "PNG") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (ascii(0, 4) === "GIF8") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "webp";
  return null;
}

/** A settings value as typed: JSON when it parses (`true`, `5`, `["dist"]`), else the text itself. */
function settingsValue(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return raw; }
}

const run = (work: () => Promise<void>) => async () => {
  try { await work(); } catch (e) { fail((e as Error).message); }
};

export function registerProjectEditCommands(projects: Command): void {
  projects
    .command("rename <name> <newName>")
    .description("Rename a project; its chats and settings stay with it")
    .action((name: string, newName: string) => run(async () => {
      const p = await projectsRequest<Project>("PATCH", projectSub(name), { name: newName });
      console.log(`${C.green}Renamed:${C.reset} ${name} → ${p.name}`);
    })());

  projects
    .command("move <name> <path>")
    .description("Point a project at another folder; the old folder is left as it is")
    .action((name: string, path: string) => run(async () => {
      const abs = resolve(path);
      await refuseFolderFromAiChat(abs, "moved");
      const p = await projectsRequest<Project>("PATCH", projectSub(name), { path: abs });
      console.log(`${C.green}Moved:${C.reset} ${p.name} → ${p.path}`);
    })());

  projects
    .command("color <name> <color>")
    .description("Set a project's colour (#rrggbb), or `none` to clear it")
    .action((name: string, color: string) => run(async () => {
      const clear = color.toLowerCase() === "none";
      if (!clear && !HEX_COLOR.test(color)) fail(`"${color}" is not a colour: give #rrggbb, or none`);
      const value = clear ? null : `#${color.replace(/^#/, "").toLowerCase()}`;
      await projectsRequest<Project>("PATCH", projectSub(name, "/color"), { color: value });
      console.log(`${C.green}Colour:${C.reset} ${name} → ${value ?? "none"}`);
    })());

  projects
    .command("icon <name> [file]")
    .description("Set a project's icon from a PNG, JPEG, GIF or WebP file (2 MB at most), or --clear it")
    .option("--clear", "Remove the project's icon")
    .action((name: string, file: string | undefined, opts: { clear?: boolean }) => run(async () => {
      if (opts.clear) {
        if (file) fail("Give a file or --clear, not both");
        await projectsRequest<Project>("DELETE", projectSub(name, "/image"));
        console.log(`${C.green}Icon cleared:${C.reset} ${name}`);
        return;
      }
      if (!file) fail("Give an image file, or --clear");
      const f = Bun.file(resolve(file));
      if (!(await f.exists())) fail(`No file at ${resolve(file)}`);
      if (f.size > MAX_ICON_BYTES) fail(`${basename(file)} is larger than 2 MB`);
      const bytes = new Uint8Array(await f.arrayBuffer());
      const kind = imageKind(bytes);
      if (!kind) fail(`${basename(file)} is not a PNG, JPEG, GIF or WebP image`);
      const form = new FormData();
      form.append("file", new File([bytes], basename(file), { type: `image/${kind}` }));
      await projectsRequest<Project>("POST", projectSub(name, "/image"), form);
      console.log(`${C.green}Icon set:${C.reset} ${name}`);
    })());

  projects
    .command("reorder <names...>")
    .description("Put projects in this order; projects not named keep their order after them")
    .action((names: string[]) => run(async () => {
      const r = await projectsRequest<{ reordered: number }>("PATCH", "/reorder", { order: names });
      console.log(`${C.green}Reordered:${C.reset} ${r.reordered} projects`);
    })());

  projects
    .command("clone <url> <dir>")
    .description("Clone a git repository into <dir>/<name> and register it as a project")
    .option("-n, --name <name>", "Folder and project name (defaults to the repository's name)")
    .action((url: string, dir: string, opts: { name?: string }) => run(async () => {
      const { repoNameFromCloneUrl } = await import("../../services/git.service.ts");
      const parent = resolve(dir.startsWith("~") ? dir.replace(/^~/, homedir()) : dir);
      const folder = opts.name || repoNameFromCloneUrl(url);
      if (!folder) fail("Cannot tell the repository's name from the URL; pass --name");
      await refuseFolderFromAiChat(resolve(parent, folder), "cloned");
      const r = await projectsRequest<{ path: string; project: Project }>(
        "POST", "/git/clone", { url, targetDir: parent, ...(opts.name ? { name: opts.name } : {}) }, { timeoutMs: CLONE_TIMEOUT_MS },
      );
      console.log(`${C.green}Cloned:${C.reset} ${r.project.name} → ${r.path}`);
    })());

  const settings = projects.command("settings").description("Per-project settings (file filters)");

  settings
    .command("get <name>")
    .description("Print a project's settings as JSON")
    .option("--json", "Print the JSON alone, with no banner")
    .action((name: string) => run(async () => {
      console.log(JSON.stringify(await projectsRequest<Record<string, unknown>>("GET", projectSub(name, "/settings")), null, 2));
    })());

  settings
    .command("set <name> <key> <value>")
    .description("Set one setting by its dotted key (e.g. files.useIgnoreFiles false, files.filesExclude '[\"dist\"]')")
    .action((name: string, key: string, value: string) => run(async () => {
      const { setNestedValue } = await import("../utils/config-key-path.ts");
      if (!/^[A-Za-z][\w]*(\.[A-Za-z][\w]*)*$/.test(key)) fail(`"${key}" is not a settings key`);
      const patch: Record<string, unknown> = {};
      setNestedValue(patch, key, settingsValue(value));
      const updated = await projectsRequest<Record<string, unknown>>("PATCH", projectSub(name, "/settings"), patch);
      console.log(`${C.green}Updated:${C.reset} ${name} ${key}`);
      console.log(JSON.stringify(updated, null, 2));
    })());
}
