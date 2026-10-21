/**
 * Turns `mem-diag.log` into a short answer to "what was growing, and what went with it".
 *
 * Pure: takes the log's text, returns lines to print. `scripts/mem-diag-report.ts` is the
 * command around it.
 *
 * The attribution is deliberately simple. Within one process run, every interval has a
 * private-byte delta and a count of spawns per command. For each command, a slope through
 * the origin (`Σ count·delta / Σ count²`) estimates MB per spawn, and the correlation says
 * whether the two actually move together. It cannot separate two commands that always run
 * together, and a leak not tied to a spawn shows up as growth no command explains — which is
 * then the cue to look at the gauges and `nativeOwners` trends printed below it.
 */

export interface DiagLine {
  t: string;
  role?: string;
  pid?: number;
  upMin?: number;
  rssMB?: number;
  privateMB?: number;
  privateDeltaMB?: number;
  heapMB?: number;
  handles?: number;
  spawned?: Record<string, number>;
  liveChildren?: number;
  nativeOwners?: Record<string, number>;
  gauges?: Record<string, number | string>;
  alert?: string;
  snapshot?: string;
}

export interface CommandAttribution {
  label: string;
  spawns: number;
  mbPerSpawn: number;
  correlation: number;
}

/** Parse the log, skipping torn or foreign lines. */
export function parseDiagLog(text: string): DiagLine[] {
  const out: DiagLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const obj = JSON.parse(raw) as DiagLine;
      if (typeof obj.t === "string") out.push(obj);
    } catch { /* a line cut by a crash mid-write */ }
  }
  return out;
}

/** Split samples into process runs: a new pid, or uptime going backwards, starts a run. */
export function splitRuns(lines: DiagLine[]): DiagLine[][] {
  const runs: DiagLine[][] = [];
  let current: DiagLine[] = [];
  for (const l of lines) {
    if (l.alert || l.snapshot || l.rssMB === undefined) continue;
    const prev = current[current.length - 1];
    const restarted = prev && ((l.pid !== undefined && prev.pid !== undefined && l.pid !== prev.pid)
      || (l.upMin !== undefined && prev.upMin !== undefined && l.upMin < prev.upMin));
    if (restarted) { runs.push(current); current = []; }
    current.push(l);
  }
  if (current.length) runs.push(current);
  return runs;
}

/** MB-per-spawn and correlation per command over one run's intervals. */
export function attributeGrowth(run: DiagLine[], minSpawns = 5): CommandAttribution[] {
  const samples = run.filter((l) => typeof l.privateDeltaMB === "number" && l.spawned);
  const labels = new Set<string>();
  for (const s of samples) for (const k of Object.keys(s.spawned!)) labels.add(k);
  const deltas = samples.map((s) => s.privateDeltaMB!);
  const out: CommandAttribution[] = [];
  for (const label of labels) {
    const counts = samples.map((s) => s.spawned![label] ?? 0);
    const spawns = counts.reduce((a, b) => a + b, 0);
    if (spawns < minSpawns) continue;
    let cd = 0, cc = 0;
    counts.forEach((c, i) => { cd += c * (deltas[i] ?? 0); cc += c * c; });
    out.push({ label, spawns, mbPerSpawn: cc ? cd / cc : 0, correlation: pearson(counts, deltas) });
  }
  return out.sort((a, b) => b.mbPerSpawn * b.spawns - a.mbPerSpawn * a.spawns);
}

function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  x.forEach((xi, i) => {
    const dx = xi - mx, dy = (y[i] ?? 0) - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  });
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

/** Numeric series that grew most between a run's first and last sample. */
function trends(first0: DiagLine, last0: DiagLine, pick: (l: DiagLine) => Record<string, number | string> | undefined): Array<[string, number, number]> {
  const first = pick(first0) ?? {};
  const last = pick(last0) ?? {};
  const rows: Array<[string, number, number]> = [];
  for (const [k, v] of Object.entries(last)) {
    const a = Number(first[k] ?? 0), b = Number(v);
    if (Number.isFinite(a) && Number.isFinite(b) && b !== a) rows.push([k, a, b]);
  }
  return rows.sort((p, q) => (q[2] - q[1]) - (p[2] - p[1]));
}

const fmt = (n: number | undefined, unit = "") => (n === undefined ? "—" : `${Math.round(n).toLocaleString("en-US")}${unit}`);

/** The whole report as printable lines. `lastRuns` limits output to the most recent runs. */
export function buildReport(text: string, lastRuns = 3): string[] {
  const lines = parseDiagLog(text);
  const out: string[] = [];
  const runs = splitRuns(lines).slice(-lastRuns);
  if (runs.length === 0) return ["No samples in the log. Is PPM_MEM_DIAG=1 set for the process?"];

  for (const run of runs) {
    const a = run[0], z = run[run.length - 1];
    if (!a || !z) continue;
    const hours = Math.max(1 / 60, (Date.parse(z.t) - Date.parse(a.t)) / 3_600_000);
    out.push("", `== ${a.role ?? "server"} pid=${a.pid ?? "?"}  ${a.t} → ${z.t}  (${hours.toFixed(1)} h, ${run.length} samples)`);
    if (a.privateMB === undefined) {
      out.push("   This run predates private-byte sampling: only RSS/heap are available.");
    } else {
      const rate = ((z.privateMB ?? 0) - (a.privateMB ?? 0)) / hours;
      out.push(`   private ${fmt(a.privateMB)} → ${fmt(z.privateMB)} MB  (${rate >= 0 ? "+" : ""}${fmt(rate)} MB/h)`);
      // Growth the JS heap accounts for is a heap-snapshot problem, not a native one.
      const heapGrowth = (z.heapMB ?? 0) - (a.heapMB ?? 0);
      const privateGrowth = (z.privateMB ?? 0) - (a.privateMB ?? 0);
      if (privateGrowth > 0) out.push(`   JS heap explains ${fmt(Math.max(0, heapGrowth))} MB of that ${fmt(privateGrowth)} MB; the rest is native`);
    }
    out.push(`   rss ${fmt(a.rssMB)} → ${fmt(z.rssMB)} MB   heap ${fmt(a.heapMB)} → ${fmt(z.heapMB)} MB   handles ${fmt(a.handles)} → ${fmt(z.handles)}   live children ${fmt(a.liveChildren)} → ${fmt(z.liveChildren)}`);

    const attribution = attributeGrowth(run);
    if (attribution.length) {
      out.push("   Spawns vs private growth (slope through origin; correlation -1..1):");
      for (const c of attribution.slice(0, 12)) {
        out.push(`     ${c.label.padEnd(32)} ${String(c.spawns).padStart(6)} spawns  ${c.mbPerSpawn.toFixed(1).padStart(7)} MB/spawn  r=${c.correlation.toFixed(2)}`);
      }
    }

    const jumps = run
      .filter((l) => (l.privateDeltaMB ?? 0) > 0)
      .sort((p, q) => (q.privateDeltaMB ?? 0) - (p.privateDeltaMB ?? 0))
      .slice(0, 8);
    if (jumps.length) {
      out.push("   Largest single-interval jumps:");
      for (const j of jumps) {
        const spawned = Object.entries(j.spawned ?? {}).sort((p, q) => q[1] - p[1]).slice(0, 5).map(([k, v]) => `${k}×${v}`).join(", ");
        out.push(`     ${j.t}  +${fmt(j.privateDeltaMB)} MB  spawned: ${spawned || "none"}`);
      }
    }

    const gaugeTrends = trends(a, z, (l) => l.gauges).slice(0, 10);
    if (gaugeTrends.length) {
      out.push("   Gauges (first → last):");
      for (const [k, x, y] of gaugeTrends) out.push(`     ${k.padEnd(32)} ${fmt(x)} → ${fmt(y)}`);
    }
    const ownerTrends = trends(a, z, (l) => l.nativeOwners).slice(0, 8);
    if (ownerTrends.length) {
      out.push("   Objects owning native memory (first → last):");
      for (const [k, x, y] of ownerTrends) out.push(`     ${k.padEnd(32)} ${fmt(x)} → ${fmt(y)}`);
    }
  }

  const alerts = lines.filter((l) => l.alert);
  if (alerts.length) {
    out.push("", "Threshold alerts (full detail is in the log line):");
    for (const al of alerts.slice(-10)) out.push(`   ${al.t}  ${al.role ?? "server"} pid=${al.pid}  ${al.alert}  ${fmt((al as { privateMB?: number }).privateMB)} MB`);
  }
  return out;
}
