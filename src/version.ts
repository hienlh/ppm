import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf-8"));

/** App version from package.json — single source of truth */
export const VERSION: string = pkg.version;
