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
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`HTML preview fixture exited: ${child.exitCode}`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`HTML preview fixture did not become ready: ${url}`);
}

/** Starts disposable real API/Vite instances; never connects to the user's running PPM. */
export async function createHtmlPreviewHarness() {
  const artifacts = process.env.PPM_HTML_PREVIEW_ARTIFACTS
    ? resolve(process.env.PPM_HTML_PREVIEW_ARTIFACTS) : await mkdtemp(join(tmpdir(), "ppm-html-preview-results-"));
  await mkdir(artifacts, { recursive: true });
  const sandbox = await mkdtemp(join(tmpdir(), "ppm-html-preview-"));
  const ppm = join(sandbox, "ppm"), home = join(sandbox, "home"), project = join(sandbox, "project");
  await Promise.all([mkdir(ppm), mkdir(home), mkdir(project)]);
  const git = spawn("git", ["init", project], { windowsHide: true, stdio: "ignore" });
  await new Promise((done, reject) => {
    git.on("exit", (code) => code === 0 ? done() : reject(new Error("Scratch git init failed")));
    git.on("error", reject);
  });
  const apiPort = await freePort(), webPort = await freePort();
  const api = `http://127.0.0.1:${apiPort}`, web = `http://127.0.0.1:${webPort}`;
  const env = { ...process.env, PPM_HOME: ppm, HOME: home, USERPROFILE: home,
    PPM_HTML_TEST_REAL_HOME: homedir(), PPM_HTML_TEST_PORT: String(apiPort), PPM_DEV_API: api };
  delete env.PPM_ALLOW_PROD_DB;
  const backend = spawn(process.env.PPM_BUN || "bun", ["tests/e2e/fixtures/html-preview-server.ts"], { cwd: process.cwd(), env, windowsHide: true });
  const frontend = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "vite.config.ts", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], { cwd: process.cwd(), env, windowsHide: true });
  const logs = { api: "", web: "" };
  for (const [name, child] of [["api", backend], ["web", frontend]]) {
    child.stdout.on("data", (chunk) => { logs[name] += chunk; });
    child.stderr.on("data", (chunk) => { logs[name] += chunk; });
    child.on("error", (error) => { logs[name] += String(error); });
  }
  const cleanup = async () => {
    try { await fetch(`${api}/__html-test/shutdown`, { method: "POST", signal: AbortSignal.timeout(1000) }); } catch {}
    await new Promise((done) => setTimeout(done, 200));
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
