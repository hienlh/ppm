import type { Command } from "commander";
import { existsSync } from "fs";
import * as readline from "readline";
import { configService } from "../../services/config.service.ts";
import { ProjectService } from "../../services/project.service.ts";

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize PPM in current directory")
    .option("-c, --config <path>", "Config file path")
    .action(async (options: { config?: string }) => {
      const configPath = options.config;
      configService.load(configPath);

      const cwd = process.cwd();
      const projectService = new ProjectService(configService);

      console.log("Scanning for git repositories...");
      const repos = projectService.scanForGitRepos(cwd, 3);

      if (repos.length === 0) {
        console.log("No git repositories found in current directory.");
      } else {
        console.log(`Found ${repos.length} git repo(s):`);
        for (const repo of repos) {
          console.log(`  ${repo}`);
          const answer = await prompt(`  Add "${repo}" to PPM? [y/N] `);
          if (answer.toLowerCase() === "y") {
            try {
              projectService.add(repo);
              console.log(`  Added.`);
            } catch (err) {
              console.log(`  Skipped: ${err}`);
            }
          }
        }
      }

      const savedPath = configService.getConfigPath();
      if (!existsSync(savedPath)) {
        configService.save();
      } else {
        configService.save();
      }

      console.log(`\nConfig saved to: ${savedPath}`);
      console.log('Run "ppm start" to launch the server.');
    });
}
