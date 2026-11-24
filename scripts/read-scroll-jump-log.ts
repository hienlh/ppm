/**
 * TEMPORARY — goes with `src/web/lib/scroll-jump-log.ts` and is removed with it.
 *
 * Prints the `[scroll-jump]` records the browsers shipped to the session trace: every upward move
 * of a chat that no wheel, touch or key asked for. Opens the trace read-only and imports nothing
 * from `src/`, so it touches no PPM database and is safe against a running PPM.
 *
 *   bun scripts/read-scroll-jump-log.ts                 # the last 7 days, jumps that left the view up
 *   bun scripts/read-scroll-jump-log.ts --days 3 --all  # also the moves that ended at the bottom
 *   bun scripts/read-scroll-jump-log.ts --json          # one JSON record per line, for a closer look
 *   bun scripts/read-scroll-jump-log.ts --db <path>     # another trace file (default: $PPM_HOME or ~/.ppm)
 *
 * A move that ends at the bottom (`distFromBottom` after it under 80 px) is the browser fitting the
 * offset to content that got shorter while the view followed the bottom, and a move written by the
 * reading anchor (`restoreRow` in its stack) is the reader's place being put back after content
 * above it changed: neither is anything the reader sees jump. Both are hidden unless `--all` is
 * given; the rest are the jumps that were reported.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const option = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const days = Number(option("--days") ?? 7);
const dbPath = option("--db") ?? join(process.env.PPM_HOME || join(homedir(), ".ppm"), "session-trace.db");
if (!existsSync(dbPath)) {
  console.error(`No session trace at ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
db.exec("PRAGMA busy_timeout = 5000");
const since = Date.now() - days * 86_400_000;
const rows = db.query(
  `SELECT ts, ref_id, payload_json FROM session_events
   WHERE source = 'browser' AND type = 'console_warn' AND ts >= ? AND payload_json LIKE '%[scroll-jump]%'
   ORDER BY ts`,
).all(since) as Array<{ ts: number; ref_id: string | null; payload_json: string }>;
db.close();

interface Parsed { ts: number; refId: string | null; record: Record<string, any> | null; raw: string }

/** The record from a row: `[scroll-jump]` then the record and, apart, the write with its stack. */
function parse(row: { ts: number; ref_id: string | null; payload_json: string }): Parsed {
  try {
    const args = (JSON.parse(row.payload_json).args ?? []) as string[];
    // Written as "[scroll-jump] {json}" in one argument, or as three: the tag, the record, the write.
    const joined = args[0]?.startsWith("[scroll-jump] {") ? args[0].slice("[scroll-jump] ".length) : args[1];
    const record = joined ? JSON.parse(joined) : null;
    if (record && args[2] && args[2] !== "null") record.write = JSON.parse(args[2]);
    return { ts: row.ts, refId: row.ref_id, record, raw: row.payload_json };
  } catch {
    return { ts: row.ts, refId: row.ref_id, record: null, raw: row.payload_json.slice(0, 300) };
  }
}

const parsed = rows.map(parse);
const leftUp = (p: Parsed) => (p.record?.distFromBottom?.[1] ?? Infinity) > 80;
/** The reading anchor putting the reader's place back after content above it changed: nothing seen to move. */
const keptPlace = (p: Parsed) => (p.record?.write?.stack ?? []).some((f: string) => /restoreRow|restoreReading/.test(f));
const shown = flag("--all") ? parsed : parsed.filter((p) => !p.record || (leftUp(p) && !keptPlace(p)));
console.error(`${rows.length} record(s) in the last ${days} day(s) from ${dbPath}; ${parsed.filter((p) => leftUp(p) && !keptPlace(p)).length} left the view away from the bottom unasked; ${parsed.filter(keptPlace).length} were the reading anchor keeping the place; showing ${shown.length}.`);

for (const p of shown) {
  if (flag("--json")) { console.log(JSON.stringify({ ts: p.ts, refId: p.refId, ...(p.record ?? { unreadable: p.raw }) })); continue; }
  const when = new Date(p.ts).toISOString();
  const r = p.record;
  if (!r) { console.log(`${when} (unreadable) ${p.raw}`); continue; }
  const a = r.after ?? {};
  const b = r.before ?? {};
  const clock = typeof r.clockSkewMs === "number" ? `browser clock ${r.clockSkewMs >= 0 ? "+" : ""}${r.clockSkewMs} ms vs server` : "browser clock unknown";
  console.log(`${when} ${a.surface} ${r.device?.width}x${r.device?.height}${r.device?.coarse ? " touch" : ""} session=${a.sessionId ?? "-"} ${clock}`);
  console.log(`  up ${r.drop}px  top ${r.top?.join("->")}  height ${r.scrollHeight?.join("->")}  view ${r.clientHeight?.join("->")}  fromBottom ${r.distFromBottom?.join("->")}`);
  console.log(`  phase=${a.phase} streaming=${a.isStreaming} following=${a.isAtBottom} pinned=${a.pinned} historyWindow=${a.historyWindow}`);
  console.log(`  rows ${b.rows ?? "?"}->${a.rows} last ${b.lastRowKind ?? "?"}->${a.lastRowKind} hidden ${b.hiddenRows ?? "?"}->${a.hiddenRows} cards/lines ${b.timelineItems ?? "?"}->${a.timelineItems} (previous render ${b.msAgo ?? "?"} ms before)`);
  console.log(`  socket: ${(r.recentEvents ?? []).map((e: { type: string; msAgo: number }) => `${e.type}@-${e.msAgo}ms`).join(" ") || "-"}  reader input ${r.msSinceIntent ?? "never"} ms before, layout change ${r.msSinceLayoutChange ?? "?"} ms before`);
  if (r.write) console.log(`  written by code ${r.write.msAgo} ms before (${r.write.kind} ${r.write.asked}):\n    ${(r.write.stack ?? []).join("\n    ")}`);
  else console.log("  no code wrote the offset: the browser moved it (content above or below changed size)");
}
