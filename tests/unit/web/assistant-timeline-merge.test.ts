/**
 * Cards placed among the Assistant chat's messages by time: stable for equal times, a message
 * before a card of the same time, cards newer than everything at the end, and cards older than the
 * loaded window held back only while older history exists.
 */
import { describe, expect, it } from "bun:test";
import { placeTimelineItems, rowTimes } from "../../../src/web/lib/assistant-timeline-merge";

const iso = (min: number) => new Date(Date.UTC(2026, 10, 10, 9, min)).toISOString();
const ms = (min: number) => Date.UTC(2026, 10, 10, 9, min);
const rows = [
  { id: "u1", timestamp: iso(0) },
  { id: "a1", timestamp: iso(1) },
  { id: "u2", timestamp: iso(10) },
  { id: "a2", timestamp: iso(11) },
];
type Item = { key: string; at: number };
const keys = (list: Item[] | undefined) => (list ?? []).map((i) => i.key);

describe("placeTimelineItems", () => {
  it("puts an item before the first newer message, and newer ones at the end", () => {
    const placed = placeTimelineItems(rows, [{ key: "c5", at: ms(5) }, { key: "c20", at: ms(20) }], (i) => i.at, { olderHidden: false });
    expect(keys(placed.before.get(2))).toEqual(["c5"]);
    expect(keys(placed.trailing)).toEqual(["c20"]);
    expect(placed.held).toBe(0);
  });

  it("keeps the message first when a card has the same time", () => {
    const placed = placeTimelineItems(rows, [{ key: "same", at: ms(10) }], (i) => i.at, { olderHidden: false });
    expect(keys(placed.before.get(3))).toEqual(["same"]);
  });

  it("is stable for items of equal time and sorts the rest", () => {
    const items = [{ key: "b", at: ms(5) }, { key: "a", at: ms(5) }, { key: "early", at: ms(2) }];
    const placed = placeTimelineItems(rows, items, (i) => i.at, { olderHidden: false });
    expect(keys(placed.before.get(2))).toEqual(["early", "b", "a"]);
  });

  it("holds cards older than the loaded window only while older history exists", () => {
    const old = [{ key: "old", at: ms(-30) }];
    expect(placeTimelineItems(rows, old, (i) => i.at, { olderHidden: true }).held).toBe(1);
    expect(keys(placeTimelineItems(rows, old, (i) => i.at, { olderHidden: false }).before.get(0))).toEqual(["old"]);
  });

  it("trails everything when no message is loaded", () => {
    const placed = placeTimelineItems([], [{ key: "x", at: 1 }, { key: "y", at: 0 }], (i) => i.at, { olderHidden: true });
    expect(keys(placed.trailing)).toEqual(["y", "x"]);
  });

  it("gives a row without a readable time the previous row's time", () => {
    expect(rowTimes([{ id: "a", timestamp: iso(3) }, { id: "b", timestamp: "" }])).toEqual([ms(3), ms(3)]);
  });
});
