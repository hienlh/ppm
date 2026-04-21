// Phase 4 populates. Phase 1 stub.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { OutputFile } from "./write-output.ts";

export function generateCommonTasks(root: string): OutputFile[] {
  const tmplPath = resolve(root, "templates/skill/common-tasks.md");
  if (existsSync(tmplPath)) {
    const content = readFileSync(tmplPath, "utf-8");
    return [{ relPath: "references/common-tasks.md", content }];
  }
  const stub = "# PPM Common Tasks\n\n_TODO: populated in phase 4._\n";
  return [{ relPath: "references/common-tasks.md", content: stub }];
}
