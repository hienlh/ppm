/**
 * Feasibility spike (phase-03 risk): does `codex` discover skills when
 * $CODEX_HOME/skills is a Windows DIRECTORY JUNCTION (not a real dir)?
 *
 * Method: `codex debug prompt-input` renders the model-visible input as JSON.
 * A discovered skill's name/description shows up there. We compare:
 *   A (control): CODEX_HOME/skills is a REAL dir holding the probe skill
 *   B (junction): CODEX_HOME/skills is a JUNCTION -> src dir holding the probe skill
 * If B surfaces the probe like A, junctions are followed by codex.
 *
 * Run: bun codex-junction-skill-probe.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawnSync } from "node:child_process";

const PROBE = "ppm-junction-probe-xyz";
const SKILL_MD = `---
name: ${PROBE}
description: PROBE-MARKER-7F3A unique skill used only to verify codex junction skill discovery. Use when the user mentions PROBE-MARKER-7F3A.
---

# Probe
This is a junction-discovery probe skill.
`;

function makeSkillDir(root: string) {
  const d = join(root, PROBE);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), SKILL_MD);
}

/** Copy auth.json + config.toml from real ~/.codex so codex can initialize. */
function seedHome(home: string) {
  mkdirSync(home, { recursive: true });
  for (const f of ["auth.json", "config.toml"]) {
    const src = join(homedir(), ".codex", f);
    if (existsSync(src)) cpSync(src, join(home, f));
  }
}

function runPromptInput(home: string): { code: number; out: string } {
  const r = spawnSync(process.execPath, ["x", "@openai/codex", "debug", "prompt-input", "hello"], {
    env: { ...process.env, CODEX_HOME: home },
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + "\n--STDERR--\n" + (r.stderr ?? "") };
}

function hasProbe(out: string) {
  return out.includes(PROBE) || out.includes("PROBE-MARKER-7F3A");
}

const base = mkdtempSync(join(tmpdir(), "codex-jx-"));
console.log("workdir:", base);

// ---- A: control (real skills dir) ----
const homeA = join(base, "homeA");
seedHome(homeA);
makeSkillDir(join(homeA, "skills"));
const a = runPromptInput(homeA);
console.log(`\n[A control] exit=${a.code} probeFound=${hasProbe(a.out) ? "✅ YES" : "❌ NO"}`);

// ---- B: junction skills -> external src ----
const homeB = join(base, "homeB");
seedHome(homeB);
const srcSkills = join(base, "external-skills");
mkdirSync(srcSkills, { recursive: true });
makeSkillDir(srcSkills);
let junctionErr = "";
try {
  symlinkSync(srcSkills, join(homeB, "skills"), "junction");
} catch (e) { junctionErr = String(e); }
const b = junctionErr ? { code: -1, out: "" } : runPromptInput(homeB);
console.log(`[B junction] junctionCreated=${junctionErr ? "❌ " + junctionErr : "✅"} exit=${b.code} probeFound=${hasProbe(b.out) ? "✅ YES" : "❌ NO"}`);

// ---- verdict ----
console.log("\n==================== VERDICT ====================");
if (hasProbe(a.out) && hasProbe(b.out)) console.log("✅ Codex follows the junction — feature approach is FEASIBLE.");
else if (hasProbe(a.out) && !hasProbe(b.out)) console.log("❌ Control works but junction does NOT — codex does NOT follow junction. Approach BROKEN.");
else if (!hasProbe(a.out)) console.log("⚠️ Even control (real dir) did NOT surface skill in prompt-input — test method invalid; need another probe (skills may not appear in prompt-input).");
console.log("=================================================");

// dump small samples to inspect how skills appear (or not)
console.log("\n--- A out (first 1500 chars) ---\n" + a.out.slice(0, 1500));

rmSync(base, { recursive: true, force: true });
