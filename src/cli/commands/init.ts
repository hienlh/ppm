import { resolve, basename } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { getPpmDir } from "../../services/ppm-dir.ts";
import { input, confirm, select, password } from "@inquirer/prompts";
import { configService } from "../../services/config.service.ts";
import { projectService } from "../../services/project.service.ts";
import { getAllConfig } from "../../services/db.service.ts";

const DEFAULT_PORT = 3210;

export interface InitOptions {
  port?: string;
  scan?: string;
  auth?: boolean;
  password?: string;
  share?: boolean;
  /** Skip prompts, use defaults + flags only (for VPS/scripts) */
  yes?: boolean;
}

/** Check if config already exists */
/** Check if config already exists (DB or legacy YAML) */
export function hasConfig(): boolean {
  try {
    const dbConfig = getAllConfig();
    if (Object.keys(dbConfig).length > 0) return true;
  } catch {}
  const globalConfig = resolve(getPpmDir(), "config.yaml");
  return existsSync(globalConfig);
}

export async function initProject(options: InitOptions = {}) {
  const nonInteractive = options.yes ?? false;

  // Check if already initialized
  if (hasConfig() && !nonInteractive) {
    const overwrite = await confirm({
      message: "PPM is already configured. Re-initialize? (this will overwrite your config)",
      default: false,
    });
    if (!overwrite) {
      console.log("  Cancelled.");
      return;
    }
  }

  console.log("\n  🔧 PPM Setup\n");

  // 1. Device name
  const defaultHostname = (await import("node:os")).hostname();
  const deviceName = nonInteractive
    ? (options as any).deviceName ?? defaultHostname
    : await input({
        message: "Device name (shown in UI to identify this machine):",
        default: defaultHostname,
      });

  // 2. Port
  const portValue = options.port
    ? parseInt(options.port, 10)
    : nonInteractive
      ? DEFAULT_PORT
      : parseInt(await input({
          message: "Port:",
          default: String(DEFAULT_PORT),
          validate: (v) => /^\d+$/.test(v) && +v > 0 && +v < 65536 ? true : "Enter valid port (1-65535)",
        }), 10);

  // 2. Scan directory
  const scanDir = options.scan
    ?? (nonInteractive
      ? homedir()
      : await input({
          message: "Projects directory to scan:",
          default: homedir(),
        }));

  // 3. Auth
  const authEnabled = options.auth
    ?? (nonInteractive
      ? true
      : await confirm({
          message: "Enable authentication?",
          default: true,
        }));

  // 4. Password (if auth enabled)
  let authToken = "";
  if (authEnabled) {
    authToken = options.password
      ?? (nonInteractive
        ? generateToken()
        : await password({
            message: "Set access password (leave empty to auto-generate):",
          }));
    if (!authToken) authToken = generateToken();
  }

  // 5. Share (install cloudflared)
  const wantShare = options.share
    ?? (nonInteractive
      ? false
      : await confirm({
          message: "Install cloudflared for public sharing (--share)?",
          default: false,
        }));

  // 6. Advanced settings
  let aiModel = "claude-sonnet-4-6";
  let aiEffort: "low" | "medium" | "high" | "max" = "high";
  let aiMaxTurns = 100;
  let aiApiKeyEnv = "ANTHROPIC_API_KEY";

  if (!nonInteractive) {
    const wantAdvanced = await confirm({
      message: "Configure advanced AI settings?",
      default: false,
    });

    if (wantAdvanced) {
      aiModel = await select({
        message: "AI model:",
        choices: [
          { value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (fast, recommended)" },
          { value: "claude-opus-4-6", name: "Claude Opus 4.6 (powerful)" },
          { value: "claude-haiku-4-5", name: "Claude Haiku 4.5 (cheap)" },
        ],
        default: "claude-sonnet-4-6",
      });

      aiEffort = await select({
        message: "Thinking effort:",
        choices: [
          { value: "low" as const, name: "Low" },
          { value: "medium" as const, name: "Medium" },
          { value: "high" as const, name: "High (recommended)" },
          { value: "max" as const, name: "Max" },
        ],
        default: "high" as const,
      });

      aiMaxTurns = parseInt(await input({
        message: "Max turns per chat:",
        default: "100",
        validate: (v) => /^\d+$/.test(v) && +v >= 1 && +v <= 500 ? true : "Enter 1-500",
      }), 10);

      aiApiKeyEnv = await input({
        message: "API key env variable:",
        default: "ANTHROPIC_API_KEY",
      });
    }
  }

  // Apply config
  configService.load();
  configService.set("device_name", deviceName);
  configService.set("port", portValue);
  configService.set("auth", { enabled: authEnabled, token: authToken });
  configService.set("ai", {
    default_provider: "claude",
    providers: {
      claude: {
        type: "agent-sdk",
        api_key_env: aiApiKeyEnv,
        model: aiModel,
        effort: aiEffort,
        max_turns: aiMaxTurns,
      },
    },
  });
  configService.save();

  // Scan for projects
  console.log(`\n  Scanning ${scanDir} for git repositories...`);
  const repos = projectService.scanForGitRepos(scanDir);
  const existing = configService.get("projects");
  let added = 0;

  for (const repoPath of repos) {
    const name = basename(repoPath);
    if (existing.some((p) => resolve(p.path) === repoPath || p.name === name)) continue;
    try {
      projectService.add(repoPath, name);
      added++;
    } catch {}
  }
  console.log(`  Found ${repos.length} repo(s), added ${added} new project(s).`);

  // Install cloudflared if requested
  if (wantShare) {
    console.log("\n  Installing cloudflared...");
    const { ensureCloudflared } = await import("../../services/cloudflared.service.ts");
    await ensureCloudflared();
    console.log("  ✓ cloudflared ready");
  }

  // 8. Next steps
  console.log(`\n  ✓ Config saved to ${configService.getConfigPath()}\n`);
  console.log("  Next steps:");
  console.log(`    ppm start              # Start (daemon, port ${portValue})`);
  console.log(`    ppm start -f           # Start in foreground`);
  if (wantShare) {
    console.log(`    ppm start --share      # Start + public URL`);
  }
  if (authEnabled) {
    console.log(`\n  Access password: ${authToken}`);
  }
  console.log();
}

function generateToken(): string {
  const { randomBytes } = require("node:crypto");
  return randomBytes(16).toString("hex");
}
