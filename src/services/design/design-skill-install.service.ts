/**
 * Installing the design skill Settings → Design suggests (ui-ux-pro-max), when someone presses
 * Install there. Pressing it is the consent; nothing here runs because a pane was opened.
 *
 * What lands on disk is what upstream's own installer writes for
 * `uipro init --ai <claude|codex> --global`, rebuilt from the same pinned npm package rather than
 * by running that CLI. The package is files — a SKILL.md template, CSV data, Python scripts and six
 * companion skills — so there is nobody's code to execute, only a tarball to read, and its SHA-256
 * is pinned below. `tests/e2e/design-skill-install-e2e.ts` diffs the result against a tree the real
 * CLI wrote; run it whenever the pin moves.
 *
 * Where it goes is where each runtime looks for user-level skills, measured rather than assumed:
 * - Claude: `$CLAUDE_CONFIG_DIR/skills`, else `~/.claude/skills`.
 * - Codex: `~/.agents/skills`. codex 0.160.1's `skills/list` reports that folder as `user` scope,
 *   and it is the one user folder every Codex account PPM runs shares: each account has a
 *   `CODEX_HOME` of its own under the PPM dir, so `$CODEX_HOME/skills` would reach one account,
 *   and `~/.codex/skills` is not read at all once `CODEX_HOME` points elsewhere.
 *
 * Nothing already there is replaced. A `ui-ux-pro-max` folder means that runtime has the skill,
 * and a companion whose name is taken — `design`, `brand` and `slides` are common names — is left
 * out, which is also what upstream's installer does without `--force`. Each skill is assembled
 * under the PPM dir first and renamed into place, so a failed download or unpack leaves no
 * half-written skill for a runtime to load. Across filesystems it is copied instead
 * (`moveIntoPlace`), and a copy that fails half way does leave one.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DESIGN_SKILL_SUGGESTION } from "../../shared/design-skill-suggestion.ts";
import { createLogger } from "../logger.ts";
import { getPpmDir } from "../ppm-dir.ts";
import { downloadVerified, type FetchFn } from "../speech-to-text/whisper-download.ts";
import type { DesignSkillRuntime } from "./design-user-instructions.ts";

const log = createLogger("design");

/** The npm package upstream's README installs from, pinned to one release and its bytes. */
export const DESIGN_SKILL_PACKAGE = {
  name: "ui-ux-pro-max-cli",
  version: DESIGN_SKILL_SUGGESTION.version,
  url: `https://registry.npmjs.org/ui-ux-pro-max-cli/-/ui-ux-pro-max-cli-${DESIGN_SKILL_SUGGESTION.version}.tgz`,
  sha256: "50966c6c1cf99db6c9706222df6a3094e8043413e8b94a477ff8339ebc3fef52",
} as const;

/** Upstream's platform template for each runtime (`assets/templates/platforms/<file>`). */
const PLATFORM_FILE: Record<DesignSkillRuntime, string> = { claude: "claude.json", codex: "codex.json" };

/** Only the fields the install reads. A pinned release that stops matching fails the install. */
interface PlatformConfig {
  folderStructure: { skillPath: string; filename: string; dataPath?: string };
  scriptPath: string;
  frontmatter?: Record<string, string>;
  sections?: { quickReference?: boolean };
  title: string;
  description: string;
  skillOrWorkflow: string;
}

export interface DesignSkillInstallResult {
  runtime: DesignSkillRuntime;
  /** The skill's folder: where it now is, or where one already was. */
  dir: string;
  /** False when a folder of that name was already there and was left alone. */
  installed: boolean;
  /** Companion skills written beside it; a name already taken is left out. */
  companions: string[];
}

export interface DesignSkillInstallOptions {
  /** Test seams: the home folder, `CLAUDE_CONFIG_DIR`, and where the package comes from. */
  home?: string;
  claudeConfigDir?: string;
  pkg?: { url: string; sha256: string };
  fetchFn?: FetchFn;
}

/** The folder a runtime's user-level skills live in. */
export function designSkillsDir(
  runtime: DesignSkillRuntime,
  home: string = homedir(),
  claudeConfigDir: string | undefined = process.env.CLAUDE_CONFIG_DIR,
): string {
  if (runtime === "codex") return path.join(home, ".agents", "skills");
  return path.join(claudeConfigDir ? path.resolve(claudeConfigDir) : path.join(home, ".claude"), "skills");
}

let inFlight: Promise<DesignSkillInstallResult[]> | null = null;

/**
 * Install for each runtime given, and resolve once every one has the skill. A second click, from
 * another tab or an impatient user, joins the running install instead of starting another.
 */
export function installDesignSkill(
  runtimes: DesignSkillRuntime[],
  options: DesignSkillInstallOptions = {},
): Promise<DesignSkillInstallResult[]> {
  inFlight ??= install([...new Set(runtimes)], options).finally(() => { inFlight = null; });
  return inFlight;
}

async function install(runtimes: DesignSkillRuntime[], options: DesignSkillInstallOptions): Promise<DesignSkillInstallResult[]> {
  const startedAt = performance.now();
  const home = options.home ?? homedir();
  const claudeConfigDir = "claudeConfigDir" in options ? options.claudeConfigDir : process.env.CLAUDE_CONFIG_DIR;
  const pkg = options.pkg ?? DESIGN_SKILL_PACKAGE;
  const work = path.join(getPpmDir(), "design-skill");
  mkdirSync(work, { recursive: true });
  const stage = mkdtempSync(path.join(work, "staging-"));
  try {
    const tarball = path.join(stage, "package.tgz");
    await downloadVerified({ url: pkg.url, dest: tarball, sha256: pkg.sha256, fetchFn: options.fetchFn });
    const assets = await readAssets(new Uint8Array(readFileSync(tarball)));
    const results = runtimes.map((runtime) => {
      const skillsDir = designSkillsDir(runtime, home, claudeConfigDir);
      return installFor(runtime, assets, skillsDir, home, path.join(stage, runtime));
    });
    log.info(
      `design skill ${DESIGN_SKILL_SUGGESTION.name} (sha256 ${pkg.sha256.slice(0, 12)}): ` +
      results.map((r) => `${r.runtime} ${r.installed ? `installed +${r.companions.length} companions` : "already present"}`).join(", ") +
      ` in ${Math.round(performance.now() - startedAt)}ms`,
    );
    return results;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

const ASSETS_PREFIX = "package/assets/";

/** The package's `assets/` folder, by path inside it. */
async function readAssets(tarball: Uint8Array): Promise<Map<string, Uint8Array>> {
  const assets = new Map<string, Uint8Array>();
  for (const [name, file] of await new Bun.Archive(tarball).files()) {
    if (!name.startsWith(ASSETS_PREFIX)) continue;
    const rel = name.slice(ASSETS_PREFIX.length);
    // The pinned hash already rules out a crafted archive; this keeps every write inside its
    // target even so — no `..`, no empty segment, nothing Windows reads as a drive or a separator.
    if (!rel || /[\\:]/.test(rel) || rel.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`Unexpected path in ${DESIGN_SKILL_PACKAGE.name}: ${name}`);
    }
    assets.set(rel, await file.bytes());
  }
  return assets;
}

function installFor(
  runtime: DesignSkillRuntime,
  assets: Map<string, Uint8Array>,
  skillsDir: string,
  home: string,
  stage: string,
): DesignSkillInstallResult {
  const config = platformConfig(assets, runtime);
  // `skills/ui-ux-pro-max` in both templates: the parent is the skills folder, the leaf the skill.
  const skillName = path.posix.basename(config.folderStructure.skillPath);
  const dir = path.join(skillsDir, skillName);
  if (existsSync(dir)) return { runtime, dir, installed: false, companions: [] };

  // The command SKILL.md tells the agent to run. Upstream writes `~/.claude/skills/ui-ux-pro-max/
  // scripts/search.py` for a global install; here it is wherever this skill really lands, which
  // differs from that only under a `CLAUDE_CONFIG_DIR`.
  const inSkill = config.scriptPath.slice(config.folderStructure.skillPath.length + 1);
  const scriptPath = homeRelative(path.join(dir, ...inSkill.split("/")), home);
  const skillMd = renderSkillFile(config, {
    skill: text(assets, "templates/base/skill-content.md"),
    quickReference: text(assets, "templates/base/quick-reference.md"),
  }, scriptPath);

  const staged = path.join(stage, skillName);
  writeFile(path.join(staged, config.folderStructure.filename), new TextEncoder().encode(skillMd));
  for (const [rel, bytes] of assets) {
    if (rel.startsWith("data/") || rel.startsWith("scripts/")) writeFile(path.join(staged, ...rel.split("/")), bytes);
  }

  const companions: string[] = [];
  for (const name of companionNames(assets)) {
    if (name === skillName || existsSync(path.join(skillsDir, name))) continue;
    const prefix = `skills/${name}/`;
    for (const [rel, bytes] of assets) {
      if (rel.startsWith(prefix)) writeFile(path.join(stage, name, ...rel.slice(prefix.length).split("/")), bytes);
    }
    companions.push(name);
  }

  mkdirSync(skillsDir, { recursive: true });
  moveIntoPlace(staged, dir);
  for (const name of companions) moveIntoPlace(path.join(stage, name), path.join(skillsDir, name));
  return { runtime, dir, installed: true, companions };
}

function platformConfig(assets: Map<string, Uint8Array>, runtime: DesignSkillRuntime): PlatformConfig {
  const config = JSON.parse(text(assets, `templates/platforms/${PLATFORM_FILE[runtime]}`)) as PlatformConfig;
  const fs = config?.folderStructure;
  // What this file assumes of the pinned templates: the skill sits directly in the skills folder,
  // its data beside it (a `dataPath` would move it elsewhere) and its script inside it.
  const fits = !!fs?.skillPath && path.posix.dirname(fs.skillPath) === "skills" && !!fs.filename && !fs.dataPath &&
    typeof config.scriptPath === "string" && config.scriptPath.startsWith(`${fs.skillPath}/`) &&
    typeof config.title === "string" && typeof config.description === "string";
  if (!fits) throw new Error(`${DESIGN_SKILL_PACKAGE.name} has an unexpected ${PLATFORM_FILE[runtime]}`);
  return config;
}

/** The companion skills the package ships (`assets/skills/<name>/`), sorted as upstream copies them. */
function companionNames(assets: Map<string, Uint8Array>): string[] {
  const names = new Set<string>();
  for (const rel of assets.keys()) {
    const match = /^skills\/([^/]+)\//.exec(rel);
    if (match) names.add(match[1]!);
  }
  return [...names].sort();
}

/** `~/…` for a path under the home folder, as upstream writes it; the absolute path otherwise. */
function homeRelative(file: string, home: string): string {
  const rel = path.relative(home, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join("/")}` : file;
}

/** Upstream's `renderFrontmatter`: a value holding `:`, `"` or a newline is quoted. */
function renderFrontmatter(frontmatter: Record<string, string> | undefined): string {
  if (!frontmatter) return "";
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    lines.push(/[:"\n]/.test(value) ? `${key}: "${value.replace(/"/g, '\\"')}"` : `${key}: ${value}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

/** Upstream's `renderSkillFile`, with function replacements so a `$` in a template stays a `$`. */
export function renderSkillFile(
  config: PlatformConfig,
  templates: { skill: string; quickReference: string },
  scriptPath: string,
): string {
  const quickReference = config.sections?.quickReference ? `\n${templates.quickReference}` : "";
  const content = templates.skill
    .replace(/\{\{TITLE\}\}/g, () => config.title)
    .replace(/\{\{DESCRIPTION\}\}/g, () => config.description)
    .replace(/\{\{SCRIPT_PATH\}\}/g, () => scriptPath)
    .replace(/\{\{SKILL_OR_WORKFLOW\}\}/g, () => config.skillOrWorkflow)
    .replace(/\{\{QUICK_REFERENCE\}\}/g, () => quickReference);
  return renderFrontmatter(config.frontmatter) + content;
}

function text(assets: Map<string, Uint8Array>, rel: string): string {
  const bytes = assets.get(rel);
  if (!bytes) throw new Error(`${DESIGN_SKILL_PACKAGE.name} has no ${rel}`);
  return new TextDecoder().decode(bytes);
}

function writeFile(file: string, bytes: Uint8Array): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

/**
 * A rename where it can be one. The PPM dir and the home folder are one filesystem on nearly every
 * install; where they are not (`EXDEV`), the folder is copied instead and the staging copy goes
 * with the rest of the staging folder.
 */
function moveIntoPlace(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
  }
}
