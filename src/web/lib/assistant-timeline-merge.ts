/**
 * Placing items that are not transcript messages (the Assistant's cards, a collapsed wake turn)
 * among a chat's loaded messages by time. Pure, so the order is testable without a browser.
 *
 * An item goes right before the first message that is newer than it; a message and an item with
 * the same time keep the message first (the turn that produced a card is already on screen when
 * the card lands). Items newer than every loaded message trail the list. Items older than the
 * oldest loaded message are held back while older history exists, so they never sit above a
 * gap; they come in with the page that reaches their time.
 */

export interface TimelineRow {
  id: string;
  /** ISO time, as transcript messages carry it. */
  timestamp: string;
}

export interface TimelinePlaced<T> {
  /** Items drawn right before the row at that index. */
  before: Map<number, T[]>;
  /** Items newer than every loaded row. */
  trailing: T[];
  /** Items older than the loaded window, held until older history is loaded. */
  held: number;
}

/** The time of each row in ms; a row with no readable time takes the previous row's. */
export function rowTimes(rows: readonly TimelineRow[]): number[] {
  const out: number[] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const t = Date.parse(row.timestamp);
    last = Number.isFinite(t) ? Math.max(t, last) : last;
    out.push(last);
  }
  return out;
}

export function placeTimelineItems<T>(
  rows: readonly TimelineRow[],
  items: readonly T[],
  at: (item: T) => number,
  opts: { olderHidden: boolean },
): TimelinePlaced<T> {
  // Stable: items with the same time keep the order they were given in.
  const sorted = items.map((item, i) => ({ item, i, t: at(item) })).sort((a, b) => a.t - b.t || a.i - b.i);
  const times = rowTimes(rows);
  const before = new Map<number, T[]>();
  const trailing: T[] = [];
  let held = 0;
  let row = 0;
  for (const { item, t } of sorted) {
    // Times are non-decreasing, so the cursor only moves forward.
    while (row < times.length && times[row]! <= t) row++;
    if (row >= times.length) { trailing.push(item); continue; }
    if (row === 0 && opts.olderHidden) { held++; continue; }
    const list = before.get(row);
    if (list) list.push(item);
    else before.set(row, [item]);
  }
  return { before, trailing, held };
}
