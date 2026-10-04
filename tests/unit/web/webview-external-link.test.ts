import { describe, expect, test } from "bun:test";
import { externalLinkRequest, OPEN_EXTERNAL_COMMAND } from "../../../src/web/components/extensions/webview-external-link";

describe("a webview asking the app to open a link", () => {
  test("any other message is the extension's, untouched", () => {
    expect(externalLinkRequest({ command: "ready" })).toBeUndefined();
    expect(externalLinkRequest("hello")).toBeUndefined();
    expect(externalLinkRequest(null)).toBeUndefined();
  });

  test("a web address opens", () => {
    expect(externalLinkRequest({ command: OPEN_EXTERNAL_COMMAND, url: "https://github.com/a/b/commit/abc1234" }))
      .toBe("https://github.com/a/b/commit/abc1234");
    expect(externalLinkRequest({ command: OPEN_EXTERNAL_COMMAND, url: "http://gitea.lan:3000/a/b" })).toBe("http://gitea.lan:3000/a/b");
  });

  test("anything that is not a web address is swallowed, never opened", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "/relative", "", 42, undefined]) {
      expect(externalLinkRequest({ command: OPEN_EXTERNAL_COMMAND, url })).toBeNull();
    }
  });
});
