/**
 * The parser reads `for-each-ref` output **positionally**, so the two halves of
 * the contract — the format string and the field indices — can only be pinned
 * together. Get one wrong and git still answers happily; the picker simply
 * shows a date where the author belongs.
 *
 * The annotated-tag case is the one worth the fixture: `refs/tags/v1` resolves
 * to the tag *object*, which has no author and no commit date, so an
 * implementation that skips the `*`-dereferenced fields renders a blank row for
 * every release tag — verified against a real `git tag -a` in
 * `git-for-each-ref-live.test.ts`.
 */
import { describe, test, expect } from "bun:test";
import {
  FOR_EACH_REF_FORMAT,
  parseForEachRef,
  parseUpstreamTrack,
} from "../../../src/services/git-refs/for-each-ref.ts";

/** One record in the exact shape the format string asks git for. */
function record(fields: Partial<Record<string, string>> & { refname: string }): string {
  const order = [
    "refname", "objectname", "derefObjectname", "head", "upstreamShort", "upstreamTrack",
    "authorname", "derefAuthorname", "committerdate", "derefCommitterdate",
    "subject", "derefSubject",
  ];
  return order.map((k) => fields[k] ?? "").join("\0");
}

describe("FOR_EACH_REF_FORMAT", () => {
  test("asks for exactly the twelve fields the parser indexes, NUL-separated", () => {
    expect(FOR_EACH_REF_FORMAT.split("%00")).toEqual([
      "%(refname)",
      "%(objectname)",
      "%(*objectname)",
      "%(HEAD)",
      "%(upstream:short)",
      "%(upstream:track)",
      "%(authorname)",
      "%(*authorname)",
      "%(committerdate:iso-strict)",
      "%(*committerdate:iso-strict)",
      "%(contents:subject)",
      "%(*contents:subject)",
    ]);
  });
});

describe("parseUpstreamTrack", () => {
  test("reads both halves, either alone, and neither", () => {
    expect(parseUpstreamTrack("[ahead 1, behind 26]")).toEqual({ ahead: 1, behind: 26, gone: false });
    expect(parseUpstreamTrack("[ahead 3]")).toEqual({ ahead: 3, behind: 0, gone: false });
    expect(parseUpstreamTrack("[behind 28]")).toEqual({ ahead: 0, behind: 28, gone: false });
    expect(parseUpstreamTrack("")).toEqual({ ahead: 0, behind: 0, gone: false });
  });

  test("a deleted upstream is `gone`, not zero ahead and zero behind", () => {
    // Both read as "in sync" on a row, which is the opposite of what happened.
    expect(parseUpstreamTrack("[gone]")).toEqual({ ahead: 0, behind: 0, gone: true });
  });
});

describe("parseForEachRef", () => {
  test("a local branch carries its short name, its commit and its tracking counts", () => {
    const [ref] = parseForEachRef(
      record({
        refname: "refs/heads/fix/NX-5907",
        objectname: "355c70f1111111111111111111111111111111ab",
        head: "*",
        upstreamShort: "origin/main",
        upstreamTrack: "[ahead 1, behind 26]",
        authorname: "thawngho",
        committerdate: "2026-09-14T14:44:12+07:00",
        subject: "fix(NX-5907): keep an unapproved timesheet out of the draft",
      }),
    );
    expect(ref).toEqual({
      refName: "refs/heads/fix/NX-5907",
      name: "fix/NX-5907",
      type: "branch",
      current: true,
      hash: "355c70f1111111111111111111111111111111ab",
      shortHash: "355c70f",
      subject: "fix(NX-5907): keep an unapproved timesheet out of the draft",
      author: "thawngho",
      date: "2026-09-14T14:44:12+07:00",
      upstream: "origin/main",
      ahead: 1,
      behind: 26,
      gone: false,
    });
  });

  test("an annotated tag reports its COMMIT, not the tag object", () => {
    const [ref] = parseForEachRef(
      record({
        refname: "refs/tags/v1",
        // The tag object: what a non-dereferencing parser would show.
        objectname: "ttttttttttttttttttttttttttttttttttttttt1",
        authorname: "",
        committerdate: "",
        subject: "the tag message",
        // The commit it points at.
        derefObjectname: "ccccccccccccccccccccccccccccccccccccccc1",
        derefAuthorname: "thawngho",
        derefCommitterdate: "2026-09-14T10:00:00+07:00",
        derefSubject: "feat: the commit subject",
      }),
    );
    expect(ref).toMatchObject({
      type: "tag",
      name: "v1",
      hash: "ccccccccccccccccccccccccccccccccccccccc1",
      shortHash: "ccccccc",
      author: "thawngho",
      date: "2026-09-14T10:00:00+07:00",
      subject: "feat: the commit subject",
    });
  });

  test("a lightweight tag leaves every dereferenced field empty and still reads correctly", () => {
    const [ref] = parseForEachRef(
      record({
        refname: "refs/tags/light",
        objectname: "ccccccccccccccccccccccccccccccccccccccc2",
        authorname: "thawngho",
        committerdate: "2026-09-14T10:00:00+07:00",
        subject: "feat: the commit subject",
      }),
    );
    expect(ref).toMatchObject({
      type: "tag",
      hash: "ccccccccccccccccccccccccccccccccccccccc2",
      author: "thawngho",
      subject: "feat: the commit subject",
    });
  });

  test("`origin/HEAD` is dropped — it is a pointer at another row of the same list", () => {
    const out = parseForEachRef(
      [
        record({ refname: "refs/remotes/origin/HEAD", objectname: "a".repeat(40), committerdate: "2026-09-14T10:00:00Z" }),
        record({ refname: "refs/remotes/origin/main", objectname: "b".repeat(40), committerdate: "2026-09-14T10:00:00Z" }),
      ].join("\n"),
    );
    expect(out.map((r) => r.name)).toEqual(["origin/main"]);
    expect(out[0]!.type).toBe("remote");
  });

  test("a record short of twelve fields is skipped, never read shifted", () => {
    // A field that somehow carried a newline: one lost row beats every field of
    // that row landing one place to the left.
    const out = parseForEachRef(`refs/heads/broken\0${"a".repeat(40)}\n${record({
      refname: "refs/heads/fine",
      objectname: "c".repeat(40),
      committerdate: "2026-09-14T10:00:00Z",
    })}`);
    expect(out.map((r) => r.name)).toEqual(["fine"]);
  });

  test("newest commit first, compared as instants rather than as strings", () => {
    // Same moment, two offsets: a string sort puts the +07:00 row first because
    // "16" > "09", which is the wrong answer by nine hours.
    const out = parseForEachRef(
      [
        record({ refname: "refs/heads/older", objectname: "a".repeat(40), committerdate: "2026-09-14T16:00:00+07:00" }),
        record({ refname: "refs/heads/newer", objectname: "b".repeat(40), committerdate: "2026-09-14T09:30:00+00:00" }),
      ].join("\n"),
    );
    expect(out.map((r) => r.name)).toEqual(["newer", "older"]);
  });
});
