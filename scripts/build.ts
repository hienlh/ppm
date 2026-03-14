#!/usr/bin/env bun
/**
 * Build script: compile frontend (Vite) + backend (Bun) into single binary.
 * Usage: bun run scripts/build.ts [--target <bun-target>]
 */
import { $ } from "bun";
import { parseArgs } from "util";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    target: { type: "string", default: "" },
  },
});

console.log("Building frontend...");
await $`bun run vite build`;

console.log("Compiling binary...");
const targetArgs = values.target ? `--target=${values.target}` : "";
const outfile = values.target
  ? `dist/ppm-${values.target.replace("bun-", "")}`
  : "dist/ppm";

if (values.target) {
  await $`bun build src/index.ts --compile --target=${values.target} --outfile=${outfile}`;
} else {
  await $`bun build src/index.ts --compile --outfile=${outfile}`;
}

console.log(`Build complete: ${outfile}`);
