/**
 * What "install the WebRTC relay" downloads: one MediaMTX build per platform.
 *
 * MediaMTX is a single static Go binary (Pion underneath) that takes PPM's existing H.264
 * over RTSP and serves it to a browser as WebRTC, **without re-encoding** — verified against
 * v1.21.1: a 1920x1080 Main@4.0 stream pushed by ffmpeg arrived at the browser as
 * `video/H264` at the same resolution. That is the whole reason this is a relay and not an
 * encoder: every bit of PPM's per-platform capture, quality ladder, cursor flag and privacy
 * mode keeps working unchanged, and only the transport moves off the WebSocket.
 *
 * Why a downloaded binary rather than a library: Bun has no WebRTC stack at all. The two
 * in-process routes were both measured and rejected — GStreamer's `webrtcbin` segfaults
 * PyGObject on GStreamer 1.28.7 + Python 3.14 (`gst_sdp_message_copy` walking a malformed
 * emails array) *and* would put GStreamer + PyGObject on every Windows and macOS host, while
 * `@roamhq/wrtc` only accepts raw i420 frames, i.e. it would throw away the hardware H.264
 * encode PPM just did and encode again in software.
 *
 * Pure and parameterised so the whole matrix is unit-testable without touching `process.*` or
 * the network. Every entry is pinned by tag AND by SHA-256, because this downloads an
 * executable onto the user's machine.
 */

/** MediaMTX release the binaries come from. Bump this and every SHA-256 below together. */
export const MEDIAMTX_VERSION = "1.21.1";

const RELEASE_BASE = `https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}`;

export interface MediamtxAsset {
  /** Archive file name as published in the release. */
  file: string;
  url: string;
  /** Lowercase hex, from the release's own `checksums.sha256`. */
  sha256: string;
  ext: "tar.gz" | "zip";
}

/**
 * Keyed `<platform>-<arch>` in Node's own vocabulary, so a caller passes `process.platform`
 * and `process.arch` straight through.
 *
 * `win32-arm64` is deliberately absent: the release publishes no Windows ARM build, and a
 * missing row has to read as "not available for this host" rather than fall back to an amd64
 * binary that would fail at spawn with nothing explaining why.
 */
const ASSETS: Record<string, MediamtxAsset> = {
  "linux-x64": {
    file: `mediamtx_v${MEDIAMTX_VERSION}_linux_amd64.tar.gz`,
    url: `${RELEASE_BASE}/mediamtx_v${MEDIAMTX_VERSION}_linux_amd64.tar.gz`,
    sha256: "653abc672a3e693f8d3b2717752492fdcfb8072291ec108d03d3dd857411b0ee",
    ext: "tar.gz",
  },
  "linux-arm64": {
    file: `mediamtx_v${MEDIAMTX_VERSION}_linux_arm64.tar.gz`,
    url: `${RELEASE_BASE}/mediamtx_v${MEDIAMTX_VERSION}_linux_arm64.tar.gz`,
    sha256: "6a3aa635fb60ea9b8d566ec306f0a42ff1b6b52a3942bc2baffbe55880d4c3dd",
    ext: "tar.gz",
  },
  "darwin-x64": {
    file: `mediamtx_v${MEDIAMTX_VERSION}_darwin_amd64.tar.gz`,
    url: `${RELEASE_BASE}/mediamtx_v${MEDIAMTX_VERSION}_darwin_amd64.tar.gz`,
    sha256: "be403a36d2225668ea695cbd2c784109bc23ef9a32f886837e43c920b6818813",
    ext: "tar.gz",
  },
  "darwin-arm64": {
    file: `mediamtx_v${MEDIAMTX_VERSION}_darwin_arm64.tar.gz`,
    url: `${RELEASE_BASE}/mediamtx_v${MEDIAMTX_VERSION}_darwin_arm64.tar.gz`,
    sha256: "25e20ed41611f1f3103b8359585210b29b11b69fa0d9e11bd11b92f7bbcb42ef",
    ext: "tar.gz",
  },
  "win32-x64": {
    file: `mediamtx_v${MEDIAMTX_VERSION}_windows_amd64.zip`,
    url: `${RELEASE_BASE}/mediamtx_v${MEDIAMTX_VERSION}_windows_amd64.zip`,
    sha256: "faa97974861eb75a68b5aa326c78e7e7a6f670b5ef191bace78e715130381f23",
    ext: "zip",
  },
};

/** The build for a host, or null when the release publishes none for it. */
export function mediamtxAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): MediamtxAsset | null {
  return ASSETS[`${platform}-${arch}`] ?? null;
}

/** Every key the catalog knows, for tests and for the Settings pane's support copy. */
export function mediamtxSupportedHosts(): string[] {
  return Object.keys(ASSETS);
}
