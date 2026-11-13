/**
 * Every process PPM starts for Antigravity gets agy's allowlisted environment, never PPM's own:
 * agy hands its environment to each command it runs, and PPM's carries tokens. The chat process
 * and the /usage read are pinned in antigravity-acp.test.ts and antigravity-usage-agy.test.ts;
 * these are the sign-in (`agy acp --login`) and the language server PPM runs for an account.
 *
 * The stand-ins are shell scripts, so this runs where /bin/sh does.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLanguageServerConnection, stopManagedLanguageServer } from "../../../src/providers/antigravity/antigravity-connection.ts";
import { cancelAntigravityLogin, startAntigravityLogin } from "../../../src/services/antigravity-account-login.ts";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { rmRetrying } from "../../helpers/rm-retrying.ts";

const SECRET = "PPM_TEST_SPAWN_SECRET";

/** The variables a stand-in wrote with `env`, once the file is there. */
async function envWritten(file: string): Promise<Map<string, string>> {
  for (let i = 0; i < 200 && !existsSync(file); i++) await Bun.sleep(10);
  const env = new Map<string, string>();
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) env.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return env;
}

describe.skipIf(process.platform === "win32")("Antigravity spawns pass the allowlist, not PPM's environment", () => {
  let dir: string;
  const saved = { agy: process.env.ANTIGRAVITY_AGY_EXE, ls: process.env.ANTIGRAVITY_LS_BIN };

  beforeEach(() => {
    setDb(openTestDb());
    dir = mkdtempSync(join(tmpdir(), "ppm-agy-env-"));
    process.env[SECRET] = "must-not-reach-agy";
  });
  afterEach(async () => {
    delete process.env[SECRET];
    if (saved.agy === undefined) delete process.env.ANTIGRAVITY_AGY_EXE;
    else process.env.ANTIGRAVITY_AGY_EXE = saved.agy;
    if (saved.ls === undefined) delete process.env.ANTIGRAVITY_LS_BIN;
    else process.env.ANTIGRAVITY_LS_BIN = saved.ls;
    await rmRetrying(dir, 20);
  });

  it("the sign-in: agy acp --login", async () => {
    const envFile = join(dir, "login.env");
    const agy = join(dir, "agy");
    writeFileSync(agy, `#!/bin/sh\nenv > "${envFile}"\necho "https://accounts.google.com/o/oauth2/auth?client_id=test"\nexec cat\n`);
    chmodSync(agy, 0o755);
    process.env.ANTIGRAVITY_AGY_EXE = agy;

    const login = await startAntigravityLogin("Env check");
    try {
      const env = await envWritten(envFile);
      expect(env.has(SECRET)).toBe(false);
      expect(env.get("PATH")).toBe(process.env.PATH);
      expect(env.get("BROWSER")).toBe("echo");
      expect(env.get("WSL_DISTRO_NAME")).toBe("ppm");
      expect(env.get("HOME")).not.toBe(process.env.HOME);
    } finally {
      cancelAntigravityLogin(login.id);
    }
  });

  it("the language server run for an account", async () => {
    const home = join(dir, "account");
    const daemonDir = join(home, ".gemini", "antigravity", "daemon");
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "jetski-standalone-oauth-token"), "tok");
    const envFile = join(dir, "ls.env");
    const ls = join(dir, "language_server");
    // Announces itself the way the real one does, then lives until its stdin closes.
    writeFileSync(ls, [
      "#!/bin/sh",
      `env > "${envFile}"`,
      'while [ "$#" -gt 0 ]; do [ "$1" = "--csrf_token" ] && csrf="$2"; shift; done',
      `mkdir -p "${daemonDir}"`,
      `printf '{"pid":%s,"httpPort":1,"csrfToken":"%s"}' "$$" "$csrf" > "${daemonDir}/ls_test.json"`,
      "cat",
      "",
    ].join("\n"));
    chmodSync(ls, 0o755);
    process.env.ANTIGRAVITY_LS_BIN = ls;

    try {
      expect(await ensureLanguageServerConnection(home)).toMatchObject({ address: "127.0.0.1:1" });
      const env = await envWritten(envFile);
      expect(env.has(SECRET)).toBe(false);
      expect(env.get("PATH")).toBe(process.env.PATH);
      expect(env.get("HOME")).toBe(home);
      expect(env.get("WSL_DISTRO_NAME")).toBe("ppm");
    } finally {
      stopManagedLanguageServer(home);
    }
  });
});
