/**
 * A turn link is recognised by its path alone — whatever origin it was copied from — and only
 * when every segment is one this PPM accepts. Anything else in a paste is left exactly as it was.
 */
import { describe, expect, it } from "bun:test";
import { buildTurnLink, parseTurnLinks, turnMetaPath } from "../../../src/web/lib/turn-link";

const SID = "0f8e2a4c-1111-4000-8000-000000000001";
const TID = "7a1b9c3d-2222-4000-8000-000000000002";
const projects = new Set(["ppm", "my project", "a/b"]);
const isProject = (name: string) => projects.has(name);

describe("turn links", () => {
  it("builds a link that parses back to the same turn", () => {
    const link = buildTurnLink("http://localhost:8080/", { projectName: "my project", providerId: "codex", sessionId: SID, turnId: `u:${TID}` });
    expect(link).toBe(`http://localhost:8080/project/my%20project/chat/codex/${SID}?turn=u%3A${TID}`);
    expect(parseTurnLinks(link, isProject).links).toEqual([
      { text: link, projectName: "my project", providerId: "codex", sessionId: SID, turnId: `u:${TID}` },
    ]);
  });

  it("ignores the origin: localhost, a tunnel, an IPv6 literal, with or without a trailing slash", () => {
    const origins = ["http://localhost:8081", "https://abc-def.trycloudflare.com", "http://[::1]:3210", "https://box.tail1234.ts.net"];
    for (const origin of origins) {
      for (const slash of ["", "/"]) {
        const text = `${origin}/project/ppm/chat/claude/${SID}${slash}?turn=${TID}`;
        expect(parseTurnLinks(text, isProject).links.map((l) => [l.projectName, l.sessionId, l.turnId])).toEqual([["ppm", SID, TID]]);
      }
    }
  });

  it("decodes an encoded project name, and takes several links from one paste in order without repeats", () => {
    const a = `https://x.test/project/a%2Fb/chat/claude/${SID}?turn=${TID}`;
    const b = `https://y.test/project/ppm/chat/codex/${SID}?other=1&turn=${TID}#frag`;
    const { links, rest } = parseTurnLinks(`first ${a}\nsecond (${b}). again ${a}`, isProject);
    expect(links.map((l) => [l.projectName, l.providerId])).toEqual([["a/b", "claude"], ["ppm", "codex"]]);
    // Only the links leave; the sentence punctuation after one stays where it was.
    expect(rest).toBe("first \nsecond (). again ");
  });

  it("leaves a chat link with no turn, a project PPM does not have, and bad segments as text", () => {
    const bad = [
      `https://x.test/project/ppm/chat/claude/${SID}`,
      `https://x.test/project/elsewhere/chat/claude/${SID}?turn=${TID}`,
      `https://x.test/project/ppm/chat/claude/not..a/session?turn=${TID}`,
      `https://x.test/project/ppm/chat/claude/${SID}?turn=..%2F..%2Fsecret`,
      `https://x.test/project/ppm/chat/gemini/${SID}?turn=${TID}`,
      `https://x.test/project/%E0%A4%A/chat/claude/${SID}?turn=${TID}`,
      `https://x.test/project/ppm/editor/src/x.ts?turn=${TID}`,
    ];
    for (const text of bad) {
      const parsed = parseTurnLinks(`see ${text} ok`, isProject);
      expect(parsed.links).toEqual([]);
      expect(parsed.rest).toBe(`see ${text} ok`);
    }
  });

  it("re-encodes every segment of the request it makes for a link", () => {
    const path = turnMetaPath({ projectName: "a/b", providerId: "claude", sessionId: SID, turnId: `u:${TID}` });
    expect(path).toBe(`/api/project/a%2Fb/chat/sessions/${SID}/turns/u%3A${TID}?providerId=claude`);
    // A decoded `/..` can never become a path step of its own.
    expect(turnMetaPath({ projectName: "../../x", providerId: "claude", sessionId: SID, turnId: TID })).toStartWith("/api/project/..%2F..%2Fx/chat/");
  });
});
