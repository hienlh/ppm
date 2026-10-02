import { describe, expect, test } from "bun:test";
import {
  buildMediamtxConfig, randomStreamPath, rtspPublishUrl, whepUrl,
} from "../../../../src/services/remote-desktop/mediamtx-config.ts";

const CONFIG = () => buildMediamtxConfig({
  rtspPort: 18554, whepPort: 18889, iceUdpPort: 18189, pathName: "sdeadbeef",
});

describe("the generated MediaMTX config", () => {
  // The whole point of generating this file is that the relay's exposure is decided here and
  // nowhere else. Measured against v1.21.1, this config leaves exactly three sockets open.
  test("ingest and signalling are confined to loopback", () => {
    const c = CONFIG();
    expect(c).toContain("rtspAddress: 127.0.0.1:18554");
    expect(c).toContain("webrtcAddress: 127.0.0.1:18889");
  });

  // The one port that cannot be confined: WebRTC media is peer-to-peer, so a browser on the
  // LAN or the tailnet has to reach it. Asserted explicitly so nobody "hardens" it to
  // loopback and silently breaks every remote viewer while the page still connects.
  test("the ICE media port is deliberately not loopback", () => {
    expect(CONFIG()).toContain("webrtcLocalUDPAddress: :18189");
  });

  test("every other server is explicitly off, not left to a default", () => {
    const c = CONFIG();
    for (const key of ["rtmp", "hls", "srt", "moq", "api", "metrics", "pprof", "playback"]) {
      expect(c).toContain(`${key}: no`);
    }
  });

  test("only the session's own path exists, and only a publisher may fill it", () => {
    const c = CONFIG();
    expect(c).toContain("paths:\n  sdeadbeef:\n    source: publisher");
  });
});

describe("the per-session stream path", () => {
  // The ICE credentials are what actually protect the media, but a guessable path would let
  // anyone who reaches the proxy ask for *this* session by name.
  test("is unguessable and differs every time", () => {
    const a = randomStreamPath(), b = randomStreamPath();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(33);
  });

  // MediaMTX path names take word characters only, so base64url would be rejected at start.
  test("uses only characters MediaMTX accepts in a path name", () => {
    for (let i = 0; i < 20; i++) expect(randomStreamPath()).toMatch(/^[A-Za-z0-9_]+$/);
  });

  test("both URLs address the relay on loopback", () => {
    expect(rtspPublishUrl(18554, "sx")).toBe("rtsp://127.0.0.1:18554/sx");
    expect(whepUrl(18889, "sx")).toBe("http://127.0.0.1:18889/sx/whep");
  });
});
