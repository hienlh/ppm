import { createHash } from "node:crypto";
import { MEMORY_SOURCES, MEMORY_TYPES, type MemoryRecord, type MemoryScope, type MemorySource, type MemoryType } from "./memory-types.ts";

/** What a memory file holds: the record minus what its location and bytes decide (id, scope, revision). */
export type MemoryFileFields = Omit<MemoryRecord, "id" | "scope" | "revision">;

/** First 12 hex of the sha256 of the whole file: the revision a write must name to replace it. */
export function memoryRevision(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

const isType = (v: string | undefined): v is MemoryType => (MEMORY_TYPES as readonly string[]).includes(v ?? "");
const isSource = (v: string | undefined): v is MemorySource => (MEMORY_SOURCES as readonly string[]).includes(v ?? "");

/** Splits off a `---` fenced frontmatter. An unclosed fence is no frontmatter: the whole file is body. */
function splitFrontmatter(text: string): { lines: string[] | null; body: string } {
  const open = /^---[ \t]*\r?\n/.exec(text);
  if (!open) return { lines: null, body: text };
  const rest = text.slice(open[0].length);
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!close) return { lines: null, body: text };
  return { lines: rest.slice(0, close.index).split(/\r?\n/), body: rest.slice(close.index + close[0].length) };
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v); } catch { return v.slice(1, -1); }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replaceAll("''", "'");
  return v;
}

/** Flat `key: value` pairs, plus the keys indented under `metadata:` (where Claude sometimes puts `type`). */
function readPairs(lines: string[]): { root: Record<string, string>; metadata: Record<string, string> } {
  const root: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  let inMetadata = false;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const kv = /^(\s*)([\w-]+):(?:[ \t]+(.*))?$/.exec(line);
    if (!kv) continue;
    const [, indent, key = "", value = ""] = kv;
    if (!indent) {
      inMetadata = key === "metadata" && !value.trim();
      if (!inMetadata) root[key] = unquote(value);
    } else if (inMetadata) {
      metadata[key] = unquote(value);
    }
  }
  return { root, metadata };
}

const firstLine = (body: string) => body.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";

/**
 * Reads one memory file. A file without frontmatter (or missing a field) still reads: the
 * file name is its name and the first body line its description. Unknown `type` → `project`,
 * unknown or missing `source` → `ppm`.
 */
export function parseMemoryFile(text: string, id: string, scope: MemoryScope): MemoryRecord {
  const { lines, body: rawBody } = splitFrontmatter(text.startsWith("﻿") ? text.slice(1) : text);
  const body = rawBody.replace(/(?:\r?\n)+$/, "");
  const { root, metadata } = readPairs(lines ?? []);
  const record: MemoryRecord = {
    id,
    scope,
    name: root.name || id,
    description: "description" in root ? root.description : firstLine(body),
    type: isType(root.type) ? root.type : isType(metadata.type) ? metadata.type : "project",
    source: isSource(root.source) ? root.source : "ppm",
    created: root.created ?? "",
    updated: root.updated ?? "",
    body,
    revision: memoryRevision(text),
  };
  if (root.archived === "true") record.archived = true;
  if ("origin" in root) record.origin = root.origin;
  if ("origin_hash" in root) record.originHash = root.origin_hash;
  return record;
}

const NEEDS_QUOTES = [
  /^$/,
  /^[\s"'#&*!|>%@`[\]{},?:-]/,
  /\s$/,
  /[\r\n\t]/,
  /: | #|:$/,
  /^(?:true|false|yes|no|on|off|null|~)$/i,
  /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i,
];

/** A plain scalar when YAML would read it back as the same string, else a double-quoted one. */
function yamlValue(v: string): string {
  return NEEDS_QUOTES.some((re) => re.test(v)) ? JSON.stringify(v) : v;
}

/** Writes a memory as flat frontmatter (in a fixed order) followed by its body. */
export function serializeMemoryFile(memory: MemoryFileFields): string {
  const lines = [
    "---",
    `name: ${yamlValue(memory.name)}`,
    `description: ${yamlValue(memory.description)}`,
    `type: ${memory.type}`,
    `source: ${memory.source}`,
    `created: ${yamlValue(memory.created)}`,
    `updated: ${yamlValue(memory.updated)}`,
  ];
  if (memory.archived) lines.push("archived: true");
  if (memory.origin !== undefined) lines.push(`origin: ${yamlValue(memory.origin)}`);
  if (memory.originHash !== undefined) lines.push(`origin_hash: ${yamlValue(memory.originHash)}`);
  lines.push("---");
  return `${lines.join("\n")}\n${memory.body ? `${memory.body}\n` : ""}`;
}
