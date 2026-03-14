import { $ } from "bun";

console.log("Building PPM...");

// 1. Build frontend (Vite)
console.log("\n[1/2] Building frontend...");
await $`bun run vite build --config vite.config.ts`;

// 2. Compile backend + embedded frontend into single binary
console.log("\n[2/2] Compiling binary...");
await $`bun build src/index.ts --compile --outfile dist/ppm`;

console.log("\nBuild complete! Binary at dist/ppm");
