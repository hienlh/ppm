import { describe, expect, test } from "bun:test";
import { previewTitle, safePreviewUrl } from "../../../src/web/lib/web-preview-url.ts";

const APP = "https://ppm.tail1234.ts.net";

describe("safePreviewUrl", () => {
  test("accepts a forward's http(s) address", () => {
    expect(safePreviewUrl("https://devbox.tail1234.ts.net:5173/", APP)).toBe("https://devbox.tail1234.ts.net:5173/");
    expect(safePreviewUrl("https://able-river.trycloudflare.com", APP)).toBe("https://able-river.trycloudflare.com/");
    expect(safePreviewUrl("http://192.168.1.20:5173/", APP)).toBe("http://192.168.1.20:5173/");
  });

  test("refuses what would run inside PPM's own origin", () => {
    // The frame keeps allow-same-origin: either of these could read PPM's session token.
    expect(safePreviewUrl("javascript:alert(document.domain)", APP)).toBeNull();
    expect(safePreviewUrl(`${APP}/`, APP)).toBeNull();
    expect(safePreviewUrl(`${APP}/api/settings`, APP)).toBeNull();
  });

  test("refuses anything that is not a URL string", () => {
    expect(safePreviewUrl("data:text/html,<script>1</script>", APP)).toBeNull();
    expect(safePreviewUrl("not a url", APP)).toBeNull();
    expect(safePreviewUrl(undefined, APP)).toBeNull();
    expect(safePreviewUrl(42, APP)).toBeNull();
  });

  test("another port on PPM's host is another origin, so it may be shown", () => {
    expect(safePreviewUrl("https://ppm.tail1234.ts.net:5173/", APP)).toBe("https://ppm.tail1234.ts.net:5173/");
  });
});

test("previewTitle names the dev server as the host knows it", () => {
  expect(previewTitle(5173, "https://devbox.tail1234.ts.net:5173/")).toBe("localhost:5173");
  expect(previewTitle(null, "https://able-river.trycloudflare.com/")).toBe("able-river.trycloudflare.com");
});
