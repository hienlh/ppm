// Shared helper: recursively create dirs then write files. Used by skill package generator.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface OutputFile {
  relPath: string;
  content: string;
}

export function writeFiles(rootDir: string, files: OutputFile[]): void {
  for (const f of files) {
    const abs = resolve(rootDir, f.relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, "utf-8");
  }
  console.log(`[generate-ppm-skill] wrote ${files.length} files to ${rootDir}`);
}
