import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { ConfigService } from "../src/services/config.service.ts";
import { ProjectService } from "../src/services/project.service.ts";
import { FileService } from "../src/services/file.service.ts";
import { createAuthMiddleware } from "../src/server/middleware/auth.ts";
import { createProjectRoutes } from "../src/server/routes/projects.ts";
import { createFileRoutes } from "../src/server/routes/files.ts";
import { createGitRoutes } from "../src/server/routes/git.ts";
import type { PpmConfig } from "../src/types/config.ts";
import { DEFAULT_CONFIG } from "../src/types/config.ts";

/** Create a temp dir with optional files, returns absolute path */
export function createTempDir(files?: Record<string, string>): string {
  const dir = join(tmpdir(), `ppm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  if (files) {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content, "utf8");
    }
  }
  return dir;
}

/** Remove a temp dir */
export function cleanupDir(dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Init a temp git repo with an initial commit, returns absolute path */
export async function createTempGitRepo(files?: Record<string, string>): Promise<string> {
  const dir = createTempDir(files ?? { "README.md": "# test\n" });

  const run = async (cmd: string[]) => {
    const proc = Bun.spawn(cmd, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
  };

  await run(["git", "init"]);
  await run(["git", "config", "user.email", "test@example.com"]);
  await run(["git", "config", "user.name", "Test"]);
  await run(["git", "add", "."]);
  await run(["git", "commit", "-m", "initial commit"]);

  return dir;
}

/** Build a Hono app for integration testing with given config */
export function buildTestApp(config: Partial<PpmConfig> = {}): Hono {
  const fullConfig: PpmConfig = { ...DEFAULT_CONFIG, ...config };
  const configService = new ConfigService();
  // Inject projects directly into config service state
  (configService as unknown as { config: PpmConfig }).config = fullConfig;
  (configService as unknown as { configPath: string }).configPath = "/dev/null";

  // Override save to no-op
  configService.save = () => {};

  const projectService = new ProjectService(configService);
  const fileService = new FileService(configService);

  const app = new Hono();
  app.use("/api/*", createAuthMiddleware(fullConfig));
  app.route("/api/projects", createProjectRoutes(projectService));
  app.route("/api/files", createFileRoutes(fileService));
  app.route("/api/git", createGitRoutes());

  return app;
}
