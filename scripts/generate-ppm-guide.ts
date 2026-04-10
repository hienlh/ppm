#!/usr/bin/env bun
/**
 * Generate the bundled PPM guide skill from docs/ and CLAUDE.md.
 * Output: assets/skills/ppm-guide/SKILL.md
 *
 * Usage: bun scripts/generate-ppm-guide.ts
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

const ROOT = resolve(dirname(import.meta.path), "..");
const OUT_DIR = resolve(ROOT, "assets/skills/ppm-guide");
const OUT_FILE = resolve(OUT_DIR, "SKILL.md");
const MAX_LINES = 150;

/** Read a file safely, return empty string if missing */
function read(rel: string): string {
  const p = resolve(ROOT, rel);
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
}

/** Extract first N non-empty lines from content */
function firstLines(content: string, n: number): string {
  return content.split("\n").filter((l) => l.trim()).slice(0, n).join("\n");
}

/** Extract a markdown section by heading (## heading) */
function extractSection(content: string, heading: string, maxLines = 15): string {
  const regex = new RegExp(`^##\\s+${heading}.*$`, "mi");
  const match = content.match(regex);
  if (!match) return "";
  const start = content.indexOf(match[0]) + match[0].length;
  const rest = content.slice(start);
  const nextHeading = rest.search(/^##\s/m);
  const section = nextHeading > 0 ? rest.slice(0, nextHeading) : rest;
  return section.split("\n").slice(0, maxLines).join("\n").trim();
}

// --- Build guide content ---
const overview = firstLines(read("docs/project-overview-pdr.md"), 8);
const claudeMd = read("CLAUDE.md");
const commands = extractSection(claudeMd, "Commands", 12);
const devConfig = extractSection(claudeMd, "Dev Config", 10);
const architecture = extractSection(claudeMd, "Architecture", 8);
const codeStandards = firstLines(read("docs/code-standards.md"), 10);

const sections = [
  "---",
  "name: ppm-guide",
  "description: PPM project structure, commands, config, and development workflow reference",
  'argument-hint: "[topic]"',
  "---",
  "",
  "# PPM Guide",
  "",
  "## Overview",
  overview,
  "",
  "## CLI Commands",
  commands || "See `ppm --help` for available commands.",
  "",
  "## Dev Config",
  devConfig || "Config stored in SQLite (~/.ppm/ppm.db). Dev uses ~/.ppm/ppm.dev.db on port 8081.",
  "",
  "## Architecture",
  architecture || "Hono (HTTP) + Bun WebSocket backend, React + Vite frontend, Claude Agent SDK for AI.",
  "",
  "## Code Standards",
  codeStandards || "See docs/code-standards.md for full conventions.",
  "",
  "## Slash Commands",
  "Use `/skills` to list all available skills and commands.",
  "Use `/help` for session help, `/status` for context usage, `/compact` to reduce context.",
  "",
  "## Dev Workflow",
  "1. `bun dev:server` — Start backend (port 8081, dev DB)",
  "2. `bun dev:web` — Start Vite frontend (port 5173)",
  "3. `bun test` — Run all tests",
  "4. `bun run typecheck` — TypeScript type checking",
];

// Enforce line cap
let output = sections.join("\n");
const lines = output.split("\n");
if (lines.length > MAX_LINES) {
  output = lines.slice(0, MAX_LINES).join("\n") + "\n";
}

// Write output
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, output, "utf-8");
console.log(`✓ Generated ${OUT_FILE} (${output.split("\n").length} lines)`);
