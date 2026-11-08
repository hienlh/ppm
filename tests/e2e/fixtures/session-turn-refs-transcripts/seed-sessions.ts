/**
 * Seeds the scratch home with the sessions the turn-reference e2e reads, written where Claude Code
 * and codex write them, so PPM finds them the way it finds real ones:
 *
 * - alpha / A: a long Claude session — 330 turns, two compactions, inline images on turns 36–44,
 *   a seeded search phrase and raw tool output on turn 77, file writes on turns 150 and 320 with
 *   the "before" copies and call history the PreToolUse hooks would have kept, an `isMeta`
 *   continue, a task notification and a prompt with no `promptId`.
 * - alpha / B: a short Claude chat, where links are pasted. alpha / F: a chat for forgery checks.
 * - alpha / C: a Codex rollout with a steered message, a compaction and a rolled-back turn.
 * - beta / D: one Claude session in a second project.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { ClaudeTranscript, type ClaudeTurnSpec } from "./claude-transcript";
import { CodexRollout } from "./codex-rollout";

export const LONG_TURNS = 330;
export const COMPACT_AFTER = [110, 220] as const;
export const IMAGE_TURNS = [36, 37, 38, 39, 40, 41, 42, 43, 44];
export const SEARCH_PHRASE = "quasar lattice migration";
export const RAW_OUTPUT = "RAW-TOOL-OUTPUT token=sk-fixture-secret";
export const NO_PROMPT_ID_TURN = 6;
export const WRITE_TURNS = { older: 150, newer: 320 } as const;

const T0 = Date.parse("2026-10-20T08:00:00.000Z");
const hex12 = (n: number) => n.toString(16).padStart(12, "0");
export const claudeSlug = (projectPath: string) => projectPath.replace(/[/\\:.]/g, "-");

/** A PNG of `w`×`h` in horizontal bands: a real image with a real decoded size. */
export function pngOf(w: number, h: number, hue: number): Buffer {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
    return (~c) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const band = Math.floor(y / 40) % 2 ? 60 : 200;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = (hue * 37) % 256; raw[o + 1] = band; raw[o + 2] = (x * 255) / w;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export interface SeedPaths {
  claudeProjects: string;
  codexSessions: string;
  uploads: string;
  alpha: string;
  beta: string;
}

export interface SeededSession { id: string; title: string; project: string; turnIds: string[] }

export interface SeedResult {
  A: SeededSession; B: SeededSession; F: SeededSession; D: SeededSession;
  C: SeededSession & { rolledBack: string };
  writes: { older: { path: string; call: string }; newer: { path: string; call: string } };
  transcriptOf: Record<string, string>;
}

function writeClaude(paths: SeedPaths, projectPath: string, transcript: ClaudeTranscript): string {
  const dir = join(paths.claudeProjects, claudeSlug(projectPath));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${transcript.sessionId}.jsonl`);
  writeFileSync(file, transcript.toString());
  return file;
}

function shortSession(paths: SeedPaths, id: string, projectPath: string, prefix: string, topic: string, n: number, start: number): { file: string; turnIds: string[] } {
  const t = new ClaudeTranscript(id, projectPath, start);
  const turnIds: string[] = [];
  for (let k = 1; k <= n; k++) {
    const promptId = `${prefix}-0000-4000-8000-${hex12(k)}`;
    turnIds.push(promptId);
    t.turn({ promptId, prompt: `${topic}, question ${k}`, answer: `${topic}: answer ${k}.`, minute: k * 2 });
  }
  return { file: writeClaude(paths, projectPath, t), turnIds };
}

export function seedSessions(paths: SeedPaths): SeedResult {
  mkdirSync(paths.uploads, { recursive: true });
  const ids = {
    A: "a1a1a1a1-1111-4111-8111-000000000001", B: "b2b2b2b2-2222-4222-8222-000000000002",
    F: "f6f6f6f6-6666-4666-8666-000000000006", D: "d4d4d4d4-4444-4444-8444-000000000004",
    C: "019ee355-cccc-7000-8000-000000000003",
  };
  const fileOf: Record<string, string> = {};

  // ── A: the long session ──
  const aFile = join(paths.claudeProjects, claudeSlug(paths.alpha), `${ids.A}.jsonl`);
  const a = new ClaudeTranscript(ids.A, paths.alpha, T0);
  const aTurns: string[] = [];
  const writes = {
    older: { path: join(paths.alpha, "notes", "older.md"), call: "toolu_01OlderNotesWrite000001" },
    newer: { path: join(paths.alpha, "notes", "newer.md"), call: "toolu_01NewerNotesWrite000001" },
  };
  for (let k = 1; k <= LONG_TURNS; k++) {
    const promptId = `aaaaaaaa-0000-4000-8000-${hex12(k)}`;
    const spec: ClaudeTurnSpec = {
      promptId, minute: k * 3,
      prompt: k === 77 ? `Q${k}: plan the ${SEARCH_PHRASE} for the storage layer` : `Q${k}: look at module ${k % 17} and report`,
      answer: k % 5 === 0
        ? `Module ${k % 17} report.\n\n${"The module keeps its state in one place and hands copies out. ".repeat(6)}\n\n- first point\n- second point\n- third point`
        : `Module ${k % 17} looks fine (answer ${k}).`,
    };
    if (IMAGE_TURNS.includes(k)) {
      const name = `seed-image-${k}.png`;
      const png = pngOf(560, 300 + (k % 4) * 60, k);
      writeFileSync(join(paths.uploads, name), png);
      spec.image = { path: join(paths.uploads, name), data: png.toString("base64") };
      spec.prompt = `Q${k}: what does this screenshot show`;
    }
    if (k === 77) spec.tool = { id: "toolu_01SearchTurnBash00000001", name: "Bash", input: { command: "cat storage.cfg" }, output: RAW_OUTPUT };
    if (k === WRITE_TURNS.older) spec.tool = { id: writes.older.call, name: "Write", input: { file_path: writes.older.path, content: "older notes\n" }, output: "File created successfully" };
    if (k === WRITE_TURNS.newer) spec.tool = { id: writes.newer.call, name: "Write", input: { file_path: writes.newer.path, content: "newer notes\n" }, output: "File created successfully" };
    if (k === 12) spec.metaContinue = true;
    if (k === 13) spec.taskNotification = true;
    if (k === NO_PROMPT_ID_TURN) {
      const uuid = `a6a6a6a6-0000-4000-8000-${hex12(k)}`;
      a.prompt("", spec.prompt, spec.minute, undefined, uuid);
      a.assistantText(spec.answer, spec.minute);
      aTurns.push(`u:${uuid}`);
    } else {
      a.turn(spec);
      aTurns.push(promptId);
    }
    if ((COMPACT_AFTER as readonly number[]).includes(k)) a.compaction(aFile, k * 3 + 1);
  }
  fileOf[ids.A] = writeClaude(paths, paths.alpha, a);

  const b = shortSession(paths, ids.B, paths.alpha, "bbbbbbbb", "Planning", 3, T0 + 86_400_000);
  const f = shortSession(paths, ids.F, paths.alpha, "ffffffff", "Forgery check", 1, T0 + 2 * 86_400_000);
  const d = shortSession(paths, ids.D, paths.beta, "dddddddd", "Billing export", 3, T0 + 3 * 86_400_000);
  fileOf[ids.B] = b.file; fileOf[ids.F] = f.file; fileOf[ids.D] = d.file;

  // ── C: Codex, with a steer, a compaction and a rolled-back turn ──
  const T = (n: number) => `019ee355-2222-7000-8000-${hex12(n)}`;
  const cStart = T0 + 4 * 86_400_000;
  const c = new CodexRollout(CodexRollout.pathFor(paths.codexSessions, ids.C, cStart), cStart).meta(ids.C, paths.alpha);
  c.taskStarted(T(1), paths.alpha).user("codex one: list the routes").call("shell", "ls src", "routes.ts").agent("codex answer one").taskComplete(T(1), "codex answer one");
  c.taskStarted(T(2), paths.alpha).user("codex two: rename the handler").user("codex two, steered: keep the old name exported")
    .agent("codex answer two, first half")
    .compacted([{ role: "user", text: "codex one: list the routes" }, { role: "assistant", text: "codex answer one" }, { role: "user", text: "codex two: rename the handler" }])
    .agent("codex answer two").taskComplete(T(2), "codex answer two");
  c.taskStarted(T(3), paths.alpha).user("codex three: delete the tests").agent("codex answer three").taskComplete(T(3), "codex answer three");
  c.rolledBack(1);
  c.taskStarted(T(4), paths.alpha).user("codex four: run the build").agent("codex answer four").taskComplete(T(4), "codex answer four");
  fileOf[ids.C] = c.path;

  return {
    A: { id: ids.A, title: "Long refactor", project: "alpha", turnIds: aTurns },
    B: { id: ids.B, title: "Planning chat", project: "alpha", turnIds: b.turnIds },
    F: { id: ids.F, title: "Forgery check", project: "alpha", turnIds: f.turnIds },
    D: { id: ids.D, title: "Billing export", project: "beta", turnIds: d.turnIds },
    C: { id: ids.C, title: "Codex rollback chat", project: "alpha", turnIds: [T(1), T(2), T(4)], rolledBack: T(3) },
    writes,
    transcriptOf: fileOf,
  };
}
