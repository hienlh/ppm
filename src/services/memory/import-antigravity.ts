import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveAntigravityPaths } from "../../providers/antigravity/antigravity-connection.ts";
import type { NativeMemory } from "./memory-types.ts";

/** What one Antigravity sync read: the items, and the folders it could not read with why. */
export interface AntigravityImport {
  items: NativeMemory[];
  skipped: string[];
  error?: string;
}

const MAX_BODY_BYTES = 64 * 1024;

/** `<geminiDir>/antigravity/knowledge` for the home PPM resolves (a custom one included). */
export function antigravityKnowledgeDir(customHome?: string): string {
  return join(resolveAntigravityPaths(customHome).geminiDir, "antigravity", "knowledge");
}

/**
 * Antigravity's knowledge items, one global memory each. Items are not per project, so
 * `projectPath` is unused; it keeps the importers' common signature. Reads only.
 */
export async function importAntigravity(
  _projectPath: string,
  homes: { antigravityHome?: string } = {},
): Promise<AntigravityImport> {
  const root = antigravityKnowledgeDir(homes.antigravityHome);
  let folders: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    folders = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { items: [], skipped: [] };
    return { items: [], skipped: [], error: `cannot read ${root}: ${(err as Error).message}` };
  }

  const items: NativeMemory[] = [];
  const skipped: string[] = [];
  for (const folder of folders) {
    const result = await readItem(join(root, folder), folder);
    if (typeof result === "string") skipped.push(`${folder}: ${result}`);
    else items.push(result);
  }
  return { items, skipped };
}

/** One knowledge item, or the reason it was skipped. */
async function readItem(dir: string, folder: string): Promise<NativeMemory | string> {
  let rawMeta: string;
  try {
    rawMeta = await readFile(join(dir, "metadata.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "no metadata.json";
    return `cannot read metadata.json: ${(err as Error).message}`;
  }
  let meta: unknown;
  try {
    meta = JSON.parse(rawMeta);
  } catch {
    return "metadata.json is not valid JSON";
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return "metadata.json is not a JSON object";
  const { title, summary } = meta as Record<string, unknown>;
  if (typeof title !== "string" || !title.trim()) return "metadata.json has no title";

  let artifacts: { rel: string; text: string }[];
  try {
    artifacts = await readMarkdown(join(dir, "artifacts"), "");
  } catch (err) {
    return `cannot read artifacts: ${(err as Error).message}`;
  }
  artifacts.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const hash = createHash("sha256").update(rawMeta);
  for (const a of artifacts) hash.update("\0").update(a.rel).update("\0").update(a.text);

  const body = artifacts.map((a) => `## ${a.rel}\n\n${a.text.trimEnd()}`).join("\n\n");
  return {
    id: `agy-${folder}`,
    scope: "global",
    name: title.trim(),
    description: typeof summary === "string" ? summary.trim() : "",
    type: "reference",
    body: capBytes(body, MAX_BODY_BYTES),
    origin: dir,
    originHash: hash.digest("hex"),
    sourceUpdated: (await stat(join(dir, "metadata.json"))).mtime.toISOString(),
  };
}

/** Every `*.md` under `dir`, paths relative to the artifacts folder with `/`. A missing folder is none. */
async function readMarkdown(dir: string, prefix: string): Promise<{ rel: string; text: string }[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: { rel: string; text: string }[] = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await readMarkdown(join(dir, e.name), rel)));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      out.push({ rel, text: await readFile(join(dir, e.name), "utf8") });
    }
  }
  return out;
}

/** Cut `text` to at most `max` UTF-8 bytes, never inside a character. */
function capBytes(text: string, max: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return text;
  let cut = max;
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
  return buf.subarray(0, cut).toString("utf8");
}
