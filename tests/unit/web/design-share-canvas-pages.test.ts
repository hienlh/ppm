import { describe, expect, it } from "bun:test";
import { sharePageFor } from "../../../src/web/design-share-page/use-share-canvas";

const ORIGIN = "https://review.example";
const BASE = `${ORIGIN}/s/CODE/f/my-design`;
const page = (href: string) => sharePageFor(href, ORIGIN, "CODE", "my-design");

describe("a link inside a shared design", () => {
  it("opens another page of the same design", () => {
    expect(page(`${BASE}/phone/1-chat/index.html`)).toBe("phone/1-chat/index.html");
    expect(page(`${BASE}/index.html`)).toBe("index.html");
    expect(page(`${BASE}/my%20page.htm`)).toBe("my page.htm");
  });

  it("goes nowhere when it leaves the design", () => {
    expect(page("https://other.example/s/CODE/f/my-design/index.html")).toBeNull();
    expect(page(`${ORIGIN}/s/OTHER/f/my-design/index.html`)).toBeNull();
    expect(page(`${ORIGIN}/s/CODE/f/other-design/index.html`)).toBeNull();
    expect(page(`${ORIGIN}/s/CODE/f/my-designer/index.html`)).toBeNull();
    expect(page(`${ORIGIN}/api/projects`)).toBeNull();
  });

  it("refuses what is not an HTML page of the design", () => {
    expect(page(`${BASE}/tokens.css`)).toBeNull();
    expect(page(`${BASE}/`)).toBeNull();
    expect(page(`${BASE}/.design/comments.html`)).toBeNull();
    expect(page(`${BASE}/a%2F..%2Fb.html`)).toBeNull();
    expect(page(`${BASE}/bad%E0.html`)).toBeNull();
    expect(page("not a url")).toBeNull();
  });
});
