import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
async function ready(url, child) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`Sandbox process exited: ${child.exitCode}`);
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`Sandbox did not become ready: ${url}`);
}

export async function createOnboardingHarness() {
  const repo = process.cwd();
  const artifacts = resolve(process.env.PPM_ONBOARDING_ARTIFACTS || "plans/260921-1839-adaptive-user-onboarding/artifacts");
  await mkdir(artifacts, { recursive: true });
  const sandbox = await mkdtemp(join(tmpdir(), "ppm-tour-"));
  const ppm = join(sandbox, "ppm");
  const home = join(sandbox, "home");
  const project = join(sandbox, "tour-project");
  await Promise.all([mkdir(ppm), mkdir(home), mkdir(project)]);
  await writeFile(join(project, "README.md"), "# Tour playground\n\nA disposable project for learning PPM.\nRun the project with `node index.js`.\n");
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "tour-playground", private: true, scripts: { start: "node index.js" } }, null, 2));
  await writeFile(join(project, "index.js"), '// Welcome to the tour playground\nconsole.log("Hello from the disposable project");\n');
  // A local empty Git repository lets the real Git view exercise its clean state.
  const git = spawn("git", ["init", project], { windowsHide: true, stdio: "ignore" });
  await new Promise((done, reject) => { git.on("exit", (code) => code === 0 ? done() : reject(new Error("scratch git init failed"))); git.on("error", reject); });
  const apiPort = await freePort(), webPort = await freePort();
  const api = `http://127.0.0.1:${apiPort}`, web = `http://127.0.0.1:${webPort}`;
  const logs = { api: "", web: "" };
  const env = { ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home, PPM_ONBOARDING_REAL_HOME: homedir(), PPM_ONBOARDING_PORT: String(apiPort), PPM_DEV_API: api };
  delete env.PPM_ALLOW_PROD_DB;
  const backend = spawn(process.env.PPM_BUN || "bun", ["tests/e2e/fixtures/onboarding-server.ts"], { cwd: repo, env, windowsHide: true });
  const frontend = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "vite.config.ts", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], { cwd: repo, env, windowsHide: true });
  for (const [name, child] of [["api", backend], ["web", frontend]]) {
    child.stdout.on("data", (chunk) => { logs[name] += chunk; });
    child.stderr.on("data", (chunk) => { logs[name] += chunk; });
  }
  const cleanup = async () => {
    try { await fetch(`${api}/__tour-test/shutdown`, { method: "POST" }); } catch {}
    await new Promise((done) => setTimeout(done, 250));
    if (backend.exitCode === null) backend.kill();
    if (frontend.exitCode === null) frontend.kill();
    await Promise.all(Object.entries(logs).map(([name, body]) => writeFile(join(artifacts, `${name}.log`), body)));
  };
  try {
    await Promise.all([ready(`${api}/api/health`, backend), ready(web, frontend)]);
    const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
    const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");
    const browser = await pw.chromium.launch({ headless: true });
    return { browser, sandbox, project, api, web, artifacts, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
