/**
 * The one write path of PPM's memory store (requirements 1.1, 7.4–7.6, 10.1, 10.3).
 *
 * Every write redacts secrets first, then replaces the file in one step (temp file + rename),
 * under one promise-chain lock per folder so two writers can never both pass the same revision
 * check. A tool may only change memories written in PPM: an imported copy would be overwritten
 * by the next sync, so that is refused; the sync itself may overwrite them. Archiving keeps the file.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseMemoryFile, serializeMemoryFile, type MemoryFileFields } from "./memory-file.ts";
import { ensureProjectMemoryDir, globalMemoryDir, projectMemoryDir } from "./memory-paths.ts";
import { redactSecrets } from "./memory-redact.ts";
import type { MemoryRecord, MemoryScope, MemorySource, MemoryType } from "./memory-types.ts";

export type MemoryCaller = "tool" | "sync";
export type MemoryStoreErrorCode = "not-found" | "revision-mismatch" | "imported" | "invalid";

export class MemoryStoreError extends Error {
  constructor(public code: MemoryStoreErrorCode, message: string, public currentRevision?: string) {
    super(message);
    this.name = "MemoryStoreError";
  }
}

export interface MemoryWriteInput {
  /** Omitted → a new PPM memory `m-<8 hex>`. A sync passes its own id (`claude-…`) and may create it. */
  id?: string;
  scope: MemoryScope;
  projectPath?: string;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  /** Honoured for the sync only; a tool always writes `ppm`. */
  source?: MemorySource;
  archived?: boolean;
  origin?: string;
  originHash?: string;
  /** Honoured for the sync only: the source's own change time, instead of now. */
  updated?: string;
}

export interface MemoryWriteOptions {
  /** Must match the current revision to replace a memory. Required for a tool update, optional for the sync. */
  expectedRevision?: string;
  caller: MemoryCaller;
}

export interface MemoryWriteResult {
  record: MemoryRecord;
  /** How many secrets were replaced with `[REDACTED]` before the file was written. */
  redacted: number;
  created: boolean;
}

/** The folder of a scope. A project scope needs the project path. */
export function memoryDir(scope: MemoryScope, projectPath?: string): string {
  if (scope === "global") return globalMemoryDir();
  if (!projectPath) throw new MemoryStoreError("invalid", "A project memory needs a project; use scope \"global\" outside one.");
  return projectMemoryDir(projectPath);
}

async function ensureDir(scope: MemoryScope, projectPath?: string): Promise<string> {
  if (scope === "project") return ensureProjectMemoryDir(projectPath!);
  const dir = globalMemoryDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

/** An id is a file name: nothing that leaves the folder or hides the file. */
function checkId(id: string): void {
  if (!id || id.length > 200 || id.startsWith(".") || /[/\\\0]/.test(id)) {
    throw new MemoryStoreError("invalid", `"${id}" is not a valid memory id.`);
  }
}

const locks = new Map<string, Promise<unknown>>();

/** Runs `fn` after every earlier operation on the same folder has finished. */
function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(dir) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  locks.set(dir, tail);
  void tail.then(() => { if (locks.get(dir) === tail) locks.delete(dir); });
  return run;
}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

async function readIn(dir: string, id: string, scope: MemoryScope): Promise<MemoryRecord | null> {
  try {
    return parseMemoryFile(await readFile(join(dir, `${id}.md`), "utf8"), id, scope);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Replaces the file in one step, so a reader never sees half of it. */
async function writeAtomic(dir: string, id: string, scope: MemoryScope, fields: MemoryFileFields): Promise<MemoryRecord> {
  const text = serializeMemoryFile(fields);
  const tmp = join(dir, `.${id}.md.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, text);
    await rename(tmp, join(dir, `${id}.md`));
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return parseMemoryFile(text, id, scope);
}

function refuseImported(existing: MemoryRecord): void {
  if (existing.source === "ppm") return;
  throw new MemoryStoreError(
    "imported",
    `Memory "${existing.id}" was copied from ${existing.source}, and its next sync would overwrite any change here — save a new PPM memory instead.`,
  );
}

function checkRevision(existing: MemoryRecord, expected: string | undefined, required: boolean): void {
  if (expected === undefined && !required) return;
  if (expected === existing.revision) return;
  throw new MemoryStoreError(
    "revision-mismatch",
    `Memory "${existing.id}" is at revision ${existing.revision}${expected ? `, not ${expected}` : ""}. Read it again, then write with revision ${existing.revision}.`,
    existing.revision,
  );
}

function newId(dir: string): string {
  for (;;) {
    const id = `m-${randomBytes(4).toString("hex")}`;
    if (!existsSync(join(dir, `${id}.md`))) return id;
  }
}

async function list(scope: MemoryScope, projectPath?: string): Promise<MemoryRecord[]> {
  const dir = memoryDir(scope, projectPath);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const ids = names.filter((n) => n.endsWith(".md") && !n.startsWith(".")).map((n) => n.slice(0, -3)).sort();
  const records = await Promise.all(ids.map((id) => readIn(dir, id, scope)));
  return records.filter((r): r is MemoryRecord => r !== null);
}

async function read(id: string, scope: MemoryScope, projectPath?: string): Promise<MemoryRecord | null> {
  checkId(id);
  return readIn(memoryDir(scope, projectPath), id, scope);
}

async function write(input: MemoryWriteInput, opts: MemoryWriteOptions): Promise<MemoryWriteResult> {
  const { scope, projectPath } = input;
  const lockDir = memoryDir(scope, projectPath);
  if (input.id !== undefined) checkId(input.id);
  return withLock(lockDir, async () => {
    const dir = await ensureDir(scope, projectPath);
    const existing = input.id === undefined ? null : await readIn(dir, input.id, scope);
    if (input.id !== undefined && !existing && opts.caller === "tool") {
      throw new MemoryStoreError("not-found", `No memory "${input.id}" in the ${scope} store. Omit the id to create one.`);
    }
    if (existing) {
      if (opts.caller === "tool") refuseImported(existing);
      checkRevision(existing, opts.expectedRevision, opts.caller === "tool");
    }

    let redacted = 0;
    const clean = (text: string) => {
      const r = redactSecrets(text);
      redacted += r.count;
      return r.text;
    };
    const stamp = now();
    const isSync = opts.caller === "sync";
    const fields: MemoryFileFields = {
      name: clean(input.name),
      description: clean(input.description),
      type: input.type,
      source: isSync ? input.source ?? existing?.source ?? "ppm" : "ppm",
      created: existing?.created || (isSync && input.updated) || stamp,
      updated: (isSync && input.updated) || stamp,
      body: clean(input.body),
    };
    if (input.archived) fields.archived = true;
    if (isSync && input.origin !== undefined) fields.origin = input.origin;
    if (isSync && input.originHash !== undefined) fields.originHash = input.originHash;

    const id = input.id ?? newId(dir);
    const record = await writeAtomic(dir, id, scope, fields);
    return { record, redacted, created: !existing };
  });
}

/** Marks a memory archived, keeping its file (7.6). */
async function archive(id: string, scope: MemoryScope, projectPath: string | undefined, opts: MemoryWriteOptions): Promise<MemoryWriteResult> {
  checkId(id);
  const dir = memoryDir(scope, projectPath);
  return withLock(dir, async () => {
    const existing = await readIn(dir, id, scope);
    if (!existing) throw new MemoryStoreError("not-found", `No memory "${id}" in the ${scope} store.`);
    if (opts.caller === "tool") refuseImported(existing);
    checkRevision(existing, opts.expectedRevision, false);
    const { id: _id, scope: _scope, revision: _rev, ...fields } = existing;
    const record = await writeAtomic(dir, id, scope, { ...fields, archived: true, updated: now() });
    return { record, redacted: 0, created: false };
  });
}

export const memoryStore = { list, read, write, archive };
