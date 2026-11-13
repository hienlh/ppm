/** A plain boxed table for a `ppm` list command: one header row, then one line per row. */
export function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const sep = `+${widths.map((w) => "-".repeat(w + 2)).join("+")}+`;
  const line = (cells: string[]) => `|${cells.map((cell, i) => ` ${(cell ?? "").padEnd(widths[i]!)} `).join("|")}|`;
  console.log(sep);
  console.log(line(headers));
  console.log(sep);
  for (const row of rows) console.log(line(row));
  console.log(sep);
}
