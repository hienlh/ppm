import { describe, expect, test } from "bun:test";
import { missingDecoderReason } from "../../../src/web/components/remote-desktop/use-h264-canvas-decoder";

describe("why WebCodecs is missing", () => {
  // Measured in one browser at one moment: VideoDecoder is undefined on
  // http://192.168.98.96:3210 and present on http://127.0.0.1:3210. PPM is routinely reached
  // over plain HTTP on a LAN, so blaming the browser sends the user to fix the wrong thing.
  test("an insecure origin is named as the cause, not the browser", () => {
    const msg = missingDecoderReason(false);
    expect(msg).toMatch(/secure origin/i);
    expect(msg).not.toMatch(/try Chrome/i);
  });

  test("it points at both real ways out", () => {
    const msg = missingDecoderReason(false);
    expect(msg).toMatch(/HTTPS/);
    expect(msg).toMatch(/relay/i);
  });

  // On a secure origin a missing VideoDecoder really is the browser, and the old advice stands.
  test("on a secure origin it still blames the browser", () => {
    const msg = missingDecoderReason(true);
    expect(msg).toMatch(/try Chrome/i);
    expect(msg).not.toMatch(/secure origin/i);
  });
});
