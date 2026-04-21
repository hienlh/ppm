#!/usr/bin/env bun
/**
 * Build-time generator: emits assets/skills/ppm/ package (SKILL.md + references/*.md).
 * Runs on prepublishOnly so the bundled skill ships with the npm package.
 * Usage: bun scripts/generate-ppm-skill.ts
 */
import { resolve, dirname } from "node:path";
import { writeFiles } from "./lib/write-output.ts";
import { generateSkillMd } from "./lib/generate-skill-md.ts";
import { generateCliReference } from "./lib/generate-cli-reference.ts";
import { generateHttpApi } from "./lib/generate-http-api.ts";
import { generateCommonTasks } from "./lib/generate-common-tasks.ts";

const ROOT = resolve(dirname(import.meta.path), "..");
const OUT = resolve(ROOT, "assets/skills/ppm");

const files = [
  ...generateSkillMd(ROOT),
  ...(await generateCliReference(ROOT)),
  ...generateHttpApi(ROOT),
  ...generateCommonTasks(ROOT),
];
writeFiles(OUT, files);
