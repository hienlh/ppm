/**
 * The design skill PPM installs must be the one upstream's installer would have written.
 *
 * Downloads the pinned `ui-ux-pro-max-cli` tarball, runs its own `uipro init --ai <claude|codex>
 * --global` into one throwaway home and PPM's Install into another, and compares the two trees
 * file by file. Needs the network; run it whenever `DESIGN_SKILL_SUGGESTION.version` moves:
 *
 *   bun tests/e2e/design-skill-install-e2e.ts
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "ppm-design-skill-e2e-"));
process.env.PPM_HOME = join(sandbox, "ppm");
delete process.env.CLAUDE_CONFIG_DIR;

const { DESIGN_SKILL_PACKAGE, installDesignSkill } = await import("../../src/services/design/design-skill-install.service.ts");

function tree(root: string, skip: Set<string>): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (dir === root && skip.has(name)) continue;
      if (statSync(full).isDirectory()) walk(full);
      else files.set(relative(root, full).split("\\").join("/"), readFileSync(full));
    }
  };
  walk(root);
  return files;
}

let failed = false;
try {
  const upstreamHome = join(sandbox, "home-upstream");
  const ppmHome = join(sandbox, "home-ppm");
  mkdirSync(upstreamHome, { recursive: true });
  mkdirSync(ppmHome, { recursive: true });

  const res = await fetch(DESIGN_SKILL_PACKAGE.url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (sha256 !== DESIGN_SKILL_PACKAGE.sha256) throw new Error(`the registry now serves other bytes: ${sha256}`);
  const unpacked = join(sandbox, "cli");
  await new Bun.Archive(bytes).extract(unpacked);

  for (const ai of ["claude", "codex"]) {
    const run = Bun.spawnSync([process.execPath, join(unpacked, "package", "dist", "index.js"), "init", "--ai", ai, "--global"], {
      cwd: sandbox, env: { ...process.env, HOME: upstreamHome, USERPROFILE: upstreamHome }, stdout: "pipe", stderr: "pipe",
    });
    if (run.exitCode !== 0) throw new Error(`uipro init --ai ${ai} failed: ${run.stderr.toString()}`);
  }
  await installDesignSkill(["claude", "codex"], { home: ppmHome, claudeConfigDir: undefined });

  // `.bun` is bun's own cache, written under HOME by running the CLI.
  const expected = tree(upstreamHome, new Set([".bun"]));
  const actual = tree(ppmHome, new Set());
  const problems: string[] = [];
  for (const [file, content] of expected) {
    const mine = actual.get(file);
    if (!mine) problems.push(`missing ${file}`);
    else if (!mine.equals(content)) problems.push(`differs ${file}`);
  }
  for (const file of actual.keys()) if (!expected.has(file)) problems.push(`extra ${file}`);
  if (problems.length) throw new Error(`PPM's install differs from upstream's:\n${problems.slice(0, 40).join("\n")}`);
  console.log(`PASS ${expected.size} files identical to uipro init --global (${DESIGN_SKILL_PACKAGE.version})`);
} catch (e) {
  failed = true;
  console.error(`FAIL ${(e as Error).message}`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
