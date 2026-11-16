import { describe, expect, it } from "bun:test";
import { daysBetween, effectiveUrgency, urgencyFloorForDue, urgencyRaisedBy } from "../../../src/shared/ppm-tasks-urgency.ts";
import { cellKey, compareTasks, rankBetween } from "../../../src/shared/ppm-tasks-order.ts";
import { canonicalPrRef, formatTaskRef, parseJiraKey, parsePrRef, parseTaskRef } from "../../../src/shared/ppm-tasks-refs.ts";

describe("urgency floors", () => {
  const today = "2026-11-16";
  it("raises by due date, never lowers", () => {
    expect(urgencyFloorForDue("2026-11-10", today)).toBe("now");
    expect(urgencyFloorForDue(today, today)).toBe("now");
    expect(urgencyFloorForDue("2026-11-17", today)).toBe("today");
    expect(urgencyFloorForDue("2026-11-22", today)).toBe("week");
    expect(urgencyFloorForDue("2026-11-23", today)).toBeNull();
    expect(urgencyFloorForDue(null, today)).toBeNull();
    expect(effectiveUrgency("later", "2026-11-17", today)).toBe("today");
    expect(effectiveUrgency("now", "2026-11-22", today)).toBe("now");
    expect(urgencyRaisedBy("week", "2026-11-20", today)).toBe(false);
    expect(urgencyRaisedBy("later", "2026-11-20", today)).toBe(true);
  });
  it("counts days across month ends and rejects malformed dates", () => {
    expect(daysBetween("2026-11-30", "2026-12-01")).toBe(1);
    expect(daysBetween("2026-11-30", "nope")).toBeNull();
    expect(urgencyFloorForDue("bad", today)).toBeNull();
  });
});

describe("order", () => {
  it("compares effective urgency, importance, rank, then number", () => {
    const t = (u: "now" | "later", i: "must" | "nice", rank: number, number: number) => ({ effectiveUrgency: u, importance: i, rank, number });
    const list = [t("later", "must", 1, 1), t("now", "nice", 1, 2), t("now", "must", 2, 3), t("now", "must", 1, 4), t("now", "must", 1, 0)];
    expect(list.sort(compareTasks).map((x) => x.number)).toEqual([0, 4, 3, 2, 1]);
    expect(cellKey({ projectKey: "p", urgency: "now", importance: "must" })).not.toBe(cellKey({ projectKey: "p", urgency: "now", importance: "nice" }));
  });
  it("finds a rank between neighbours", () => {
    expect(rankBetween(null, null)).toBe(1);
    expect(rankBetween(null, 3)).toBe(2);
    expect(rankBetween(3, null)).toBe(4);
    expect(rankBetween(1, 2)).toBe(1.5);
  });
});

describe("refs", () => {
  it("parses and formats task refs", () => {
    expect(parseTaskRef("ppm/12")).toEqual({ project: "ppm", number: 12 });
    expect(parseTaskRef("#7")).toEqual({ project: null, number: 7 });
    expect(parseTaskRef("7")).toEqual({ project: null, number: 7 });
    expect(parseTaskRef("ppm/0")).toBeNull();
    expect(parseTaskRef("a b/1")).toBeNull();
    expect(formatTaskRef(12, "ppm")).toBe("ppm/12");
    expect(formatTaskRef(12)).toBe("#12");
  });
  it("normalises Jira keys and PRs", () => {
    expect(parseJiraKey(" nx-6318 ")).toBe("NX-6318");
    expect(parseJiraKey("6318")).toBeNull();
    expect(parsePrRef("acme/umbrella-fe#412")).toEqual({ owner: "acme", repo: "umbrella-fe", number: 412 });
    expect(canonicalPrRef("https://github.com/acme/umbrella-fe/pull/412/files")).toBe("acme/umbrella-fe#412");
    expect(canonicalPrRef("https://gitlab.com/acme/x/pull/1")).toBeNull();
    expect(canonicalPrRef("acme/x")).toBeNull();
  });
});
