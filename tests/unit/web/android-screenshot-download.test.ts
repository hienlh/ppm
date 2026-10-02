/**
 * Reading the server's filename back out of the response.
 *
 * The download is the one place the user sees a name PPM chose, and a header this code does not
 * understand falls back silently — so the fallback has to be right for every shape a proxy or a
 * future route might produce, not only the one shape written today.
 */
import { describe, expect, it } from "bun:test";
import {
  filenameFromDisposition, screenshotUrl,
} from "../../../src/web/components/android/android-screenshot-download.ts";

describe("filenameFromDisposition", () => {
  it("reads the quoted form the route writes", () => {
    expect(filenameFromDisposition('attachment; filename="Pixel_9-20260921-131125.png"', "x.png"))
      .toBe("Pixel_9-20260921-131125.png");
  });

  it("reads an unquoted filename", () => {
    expect(filenameFromDisposition("attachment; filename=shot.png", "x.png")).toBe("shot.png");
  });

  it("prefers the RFC 5987 form when both are present", () => {
    const header = `attachment; filename="fallback.png"; filename*=UTF-8''M%C3%A1y%20%E1%BA%A3o.png`;
    expect(filenameFromDisposition(header, "x.png")).toBe("Máy ảo.png");
  });

  it("falls back when the header is missing or empty", () => {
    expect(filenameFromDisposition(null, "fallback.png")).toBe("fallback.png");
    expect(filenameFromDisposition("attachment", "fallback.png")).toBe("fallback.png");
    expect(filenameFromDisposition('attachment; filename=""', "fallback.png")).toBe("fallback.png");
  });

  it("falls back rather than throwing on a malformed percent-encoding", () => {
    expect(filenameFromDisposition("attachment; filename*=UTF-8''%E0%A4%A", "fallback.png"))
      .toBe("fallback.png");
  });
});

describe("screenshotUrl", () => {
  it("encodes the device id, which contains a colon", () => {
    expect(screenshotUrl("519772:8554")).toBe("/api/android/devices/519772%3A8554/screenshot");
  });
});
