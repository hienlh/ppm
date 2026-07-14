import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, basename } from "node:path";
import { invalidateAll } from "../slash-discovery/index.ts";
import { assertWithinRoots, resolveCreateTarget, isValidResourceName } from "./path-safety.ts";
import type { CreatableScope, CreatableType } from "./types.ts";

function assertEditable(filePath: string, projectPath: string): void {
  assertWithinRoots(filePath, projectPath);
  // Bundled resources live under the package's assets/skills — never mutate in place.
  if (filePath.replace(/\\/g, "/").includes("/assets/skills/")) {
    throw new Error("Bundled resources are read-only — duplicate to edit");
  }
}

/** Read a resource file's raw content (must be within managed roots). */
export function readResource(filePath: string, projectPath: string): string {
  assertWithinRoots(filePath, projectPath);
  if (!existsSync(filePath)) throw new Error("Resource not found");
  return readFileSync(filePath, "utf-8");
}

/** Overwrite a resource file's content (rejects bundled + out-of-root paths). */
export function writeResource(filePath: string, content: string, projectPath: string): void {
  assertEditable(filePath, projectPath);
  if (!existsSync(filePath)) throw new Error("Resource not found");
  writeFileSync(filePath, content, "utf-8");
  invalidateAll();
}

/** Frontmatter body template for a new resource. */
function template(type: CreatableType, name: string): string {
  if (type === "skill") {
    return `---\nname: ${name}\ndescription: \n---\n\n# ${name}\n\n`;
  }
  if (type === "agent") {
    return `---\nname: ${name}\ndescription: \nmodel: inherit\n---\n\n`;
  }
  return `---\ndescription: \nargument-hint: \n---\n\n`;
}

/** Create a new resource file from a template. Returns the new file path. */
export function createResource(
  type: CreatableType,
  scope: CreatableScope,
  name: string,
  projectPath: string,
): string {
  const { dir, filePath } = resolveCreateTarget(type, scope, name, projectPath);
  if (existsSync(filePath)) throw new Error(`A ${type} named "${name}" already exists in this scope`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, template(type, name), "utf-8");
  invalidateAll();
  return filePath;
}

/** Delete a resource. Skill dirs are removed wholesale; agent/command files unlinked. */
export function deleteResource(filePath: string, type: CreatableType, projectPath: string): void {
  assertEditable(filePath, projectPath);
  if (!existsSync(filePath)) throw new Error("Resource not found");
  if (type === "skill" && basename(filePath) === "SKILL.md") {
    rmSync(dirname(filePath), { recursive: true, force: true });
  } else {
    rmSync(filePath, { force: true });
  }
  invalidateAll();
}

/** Copy an existing resource into a writable scope under a new name. Returns new path. */
export function duplicateResource(
  srcFilePath: string,
  type: CreatableType,
  scope: CreatableScope,
  newName: string,
  projectPath: string,
): string {
  assertWithinRoots(srcFilePath, projectPath);
  if (!existsSync(srcFilePath)) throw new Error("Source resource not found");
  if (!isValidResourceName(newName)) throw new Error("Invalid resource name");
  const { dir, filePath } = resolveCreateTarget(type, scope, newName, projectPath);
  if (existsSync(filePath)) throw new Error(`A ${type} named "${newName}" already exists in this scope`);

  let content = readFileSync(srcFilePath, "utf-8");
  // Rewrite the frontmatter name field to the new name when present.
  content = content.replace(/^(---\r?\n[\s\S]*?\bname:\s*).*$/m, `$1${newName}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, content, "utf-8");
  invalidateAll();
  return filePath;
}
