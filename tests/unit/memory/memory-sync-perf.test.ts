import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { projectMemoryDir } from "../../../src/services/memory/memory-paths.ts";
import { closeMemoryIndex } from "../../../src/services/memory/memory-index.ts";
import { createMemorySync } from "../../../src/services/memory/memory-sync.ts";

const FILES = 500;
const originalPpmHome = process.env.PPM_HOME;
let root: string;
let claudeHome: string;
let projectPath: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-memory-sync-perf-"));
  process.env.PPM_HOME = join(root, "ppm");
  _resetPpmDir();
  claudeHome = join(root, "claude-home");
  projectPath = join(root, "project");
  mkdirSync(projectPath, { recursive: true });
  const encoded = realpathSync(projectPath).normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
  const dir = join(claudeHome, "projects", encoded, "memory");
  mkdirSync(dir, { recursive: true });
  const filler = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(16);
  for (let i = 0; i < FILES; i++) {
    writeFileSync(
      join(dir, `topic-${i}.md`),
      `---\nname: Topic ${i}\ndescription: what we learned about topic ${i}\ntype: project\n---\n# Topic ${i}\n\n${filler}\n`,
    );
  }
});

afterAll(() => {
  closeMemoryIndex();
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  rmSync(root, { recursive: true, force: true });
});

/** Runs `fn` while a 1 ms interval watches the event loop; returns the longest gap beyond the 1 ms asked for. */
async function longestBlock(fn: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 1);
    last = now;
  }, 1);
  try {
    await fn();
    const now = performance.now();
    worst = Math.max(worst, now - last - 1);
  } finally {
    clearInterval(timer);
  }
  return worst;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe("memory sync performance (500 Claude files)", () => {
  let instance: ReturnType<typeof createMemorySync>;
  beforeAll(() => {
    instance = createMemorySync({
      claudeHome,
      codexHomes: [join(root, "codex-home")],
      antigravityHome: join(root, "agy-home"),
      listProjects: () => [projectPath],
    });
  });

  it("never blocks the event loop for 50 ms or more while syncing", async () => {
    const worst = await longestBlock(() => instance.ensureSynced(projectPath));
    const dir = projectMemoryDir(projectPath);
    const copies = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".md")) : [];
    expect(copies).toHaveLength(FILES);
    console.log(`[memory-sync-perf] longest event-loop block during a 500-file sync: ${worst.toFixed(1)} ms`);
    expect(worst).toBeLessThan(50);
  }, 60_000);

  it("adds under 20 ms when nothing changed", async () => {
    const times: number[] = [];
    for (let i = 0; i < 9; i++) {
      const t0 = performance.now();
      await instance.ensureSynced(projectPath);
      times.push(performance.now() - t0);
    }
    console.log(`[memory-sync-perf] unchanged ensureSynced: median ${median(times).toFixed(2)} ms (${times.map((t) => t.toFixed(1)).join(", ")})`);
    expect(median(times)).toBeLessThan(20);
    // Measured against a store the sync really filled, not an empty no-op.
    expect(existsSync(join(projectMemoryDir(projectPath), "claude-topic-0.md"))).toBe(true);
  });
});
