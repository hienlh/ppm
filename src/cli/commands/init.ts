import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { configService } from "../../services/config.service.ts";
import { projectService } from "../../services/project.service.ts";

export async function initProject() {
  const ppmDir = resolve(homedir(), ".ppm");
  const globalConfig = resolve(ppmDir, "config.yaml");

  // Load existing or create default
  configService.load();
  console.log(`Config: ${configService.getConfigPath()}`);

  // Scan CWD for git repos
  const cwd = process.cwd();
  console.log(`\nScanning ${cwd} for git repositories...`);
  const repos = projectService.scanForGitRepos(cwd);

  if (repos.length === 0) {
    console.log("No git repositories found.");
  } else {
    console.log(`Found ${repos.length} git repo(s):\n`);
    const existing = configService.get("projects");

    let added = 0;
    for (const repoPath of repos) {
      const name = repoPath.split("/").pop() ?? "unknown";
      const alreadyRegistered = existing.some(
        (p) => resolve(p.path) === repoPath || p.name === name,
      );

      if (alreadyRegistered) {
        console.log(`  [skip] ${name} (${repoPath}) — already registered`);
        continue;
      }

      try {
        projectService.add(repoPath, name);
        console.log(`  [added] ${name} (${repoPath})`);
        added++;
      } catch (e) {
        console.log(`  [error] ${name}: ${(e as Error).message}`);
      }
    }

    console.log(`\nAdded ${added} project(s).`);
  }

  const auth = configService.get("auth");
  console.log(`\nAuth: ${auth.enabled ? "enabled" : "disabled"}`);
  if (auth.enabled) {
    console.log(`Token: ${auth.token}`);
  }

  console.log(`\nRun "ppm start" to start the server.`);
}
