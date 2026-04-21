// Recursive copy of the bundled skill package to a target directory.
// Skips any stale `.bak-*` files in source (defensive, should not occur in bundle).
import { cpSync, mkdirSync, existsSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { resolve, relative } from "node:path";

export function copyBundledSkill(sourceDir: string, targetDir: string): string[] {
  if (!existsSync(sourceDir)) {
    throw new Error(`Source skill dir not found: ${sourceDir}`);
  }
  mkdirSync(targetDir, { recursive: true });
  const copied: string[] = [];
  walk(sourceDir, sourceDir, targetDir, copied);
  return copied;
}

function walk(rootSrc: string, dir: string, targetRoot: string, collected: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name.includes(".bak-")) continue;
    const abs = resolve(dir, name);
    const rel = relative(rootSrc, abs);
    const dest = resolve(targetRoot, rel);
    const st = statSync(abs);
    if (st.isDirectory()) {
      mkdirSync(dest, { recursive: true });
      walk(rootSrc, abs, targetRoot, collected);
    } else if (st.isFile()) {
      copyFileSync(abs, dest);
      collected.push(dest);
    }
  }
}

// Fallback single-shot copy using Node 16.7+ cpSync (kept in case walk is bypassed).
export function copyTree(src: string, dest: string): void {
  cpSync(src, dest, { recursive: true });
}
