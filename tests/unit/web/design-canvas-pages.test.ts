import { describe, expect, it } from "bun:test";
import { designPageFor, withDesignPage } from "../../../src/web/components/design/canvas/use-design-canvas";

const ORIGIN = "http://127.0.0.1:3210";
const ROOT = `${ORIGIN}/api/design-preview/content/tok123/my-design`;
const here = `${ROOT}/index.html`;

describe("designPageFor", () => {
  it("follows a link to another page of the same design", () => {
    expect(designPageFor(`${ROOT}/phone/1-chat/index.html`, here, "my-design")).toBe("phone/1-chat/index.html");
    expect(designPageFor(`${ROOT}/about.htm?x=1#top`, here, "my-design")).toBe("about.htm");
  });

  it("follows a link back up to the design's own index", () => {
    const sub = `${ROOT}/phone/1-chat/index.html`;
    expect(designPageFor(new URL("../../index.html", sub).href, sub, "my-design")).toBe("index.html");
  });

  it("decodes the page path", () => {
    expect(designPageFor(`${ROOT}/a%20b/page.html`, here, "my-design")).toBe("a b/page.html");
  });

  it("refuses links that leave the design", () => {
    // Another design under the same token, the shared aliases, another token, another origin.
    expect(designPageFor(`${ORIGIN}/api/design-preview/content/tok123/other/index.html`, here, "my-design")).toBeNull();
    expect(designPageFor(`${ORIGIN}/api/design-preview/content/tok123/tokens.css`, here, "my-design")).toBeNull();
    expect(designPageFor(`${ORIGIN}/api/design-preview/content/other-tok/my-design/index.html`, here, "my-design")).toBeNull();
    expect(designPageFor(`https://example.com/api/design-preview/content/tok123/my-design/index.html`, here, "my-design")).toBeNull();
    expect(designPageFor(`${ORIGIN}/project/ppm/index.html`, here, "my-design")).toBeNull();
  });

  it("refuses what is not an HTML page of the design", () => {
    expect(designPageFor(`${ROOT}/styles.css`, here, "my-design")).toBeNull();
    expect(designPageFor(`${ROOT}/`, here, "my-design")).toBeNull();
    expect(designPageFor(`${ROOT}/.design/history.html`, here, "my-design")).toBeNull();
    expect(designPageFor(`${ROOT}/%2e%2e/other/index.html`, here, "my-design")).toBeNull();
    expect(designPageFor(`${ROOT}/a%2Fb.html`, here, "my-design")).toBeNull();
    expect(designPageFor("mailto:x@y.z", here, "my-design")).toBeNull();
    expect(designPageFor("not a url", "also not", "my-design")).toBeNull();
  });
});

describe("withDesignPage", () => {
  it("points a canvas URL at another page of the design", () => {
    const url = "/api/design-preview/content/tok999/my-design/index.html";
    expect(withDesignPage(url, "my-design", "phone/1-chat/index.html"))
      .toBe("/api/design-preview/content/tok999/my-design/phone/1-chat/index.html");
    expect(withDesignPage(url, "my-design", "a b/page.html"))
      .toBe("/api/design-preview/content/tok999/my-design/a%20b/page.html");
  });

  it("leaves a URL it does not recognise alone", () => {
    expect(withDesignPage("/elsewhere/index.html", "my-design", "x.html")).toBe("/elsewhere/index.html");
  });
});
