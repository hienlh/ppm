import { describe, expect, it } from "bun:test";
import {
  bitrateKbps, buildWaylandCaptureArgs, buildWaylandPublishArgs,
  type GstElements,
} from "../../../../src/services/remote-desktop/remote-desktop-capture-wayland.ts";

const GPU: GstElements = {
  launch: "/usr/bin/gst-launch-1.0", pipewiresrc: true, vapostproc: true, vah264enc: true, x264enc: true,
};
const SOFTWARE: GstElements = {
  launch: "/usr/bin/gst-launch-1.0", pipewiresrc: true, vapostproc: false, vah264enc: false, x264enc: true,
};

describe("bitrateKbps", () => {
  it("reads ffmpeg's own bitrate spellings", () => {
    expect(bitrateKbps("4M")).toBe(4000);
    expect(bitrateKbps("1500k")).toBe(1500);
    expect(bitrateKbps("800000")).toBe(800);
  });

  it("never returns zero, which every GStreamer encoder rejects", () => {
    // The smallest quality rung rounds to 0 kbps through the RustDesk ratio table; ffmpeg
    // refuses a zero bitrate and so does vah264enc, so a floor is the only safe answer.
    expect(bitrateKbps("0")).toBeGreaterThan(0);
    expect(bitrateKbps("not a bitrate")).toBeGreaterThan(0);
  });
});

describe("buildWaylandCaptureArgs", () => {
  it("addresses the portal's node and nothing else", () => {
    const a = buildWaylandCaptureArgs(64, GPU, { fps: 30, bitrate: "4M" });
    expect(a).toContain("pipewiresrc");
    expect(a).toContain("path=64");
    // The PipeWire fd is deliberately never obtained or passed — the node is reached through
    // the user's own daemon socket. An `fd=` here would mean the portal handshake grew a step
    // that cannot work from a separate process.
    expect(a.some((x) => x.startsWith("fd=") && x !== "fd=1")).toBe(false);
  });

  it("caps the frame rate with a capsfilter, never with videorate max-rate", () => {
    const a = buildWaylandCaptureArgs(1, GPU, { fps: 30, bitrate: "4M" });
    expect(a).toContain("videorate");
    expect(a).toContain("video/x-raw,framerate=30/1");
    // Measured: `max-rate=30` let 59 fps through and `max-rate=60` let 133 through. It hints,
    // it does not cap — and an uncapped 1080p60 stream is several times the intended bitrate.
    expect(a.some((x) => x.includes("max-rate"))).toBe(false);
  });

  it("ties the keyframe interval to the frame rate so a late viewer syncs within a second", () => {
    expect(buildWaylandCaptureArgs(1, GPU, { fps: 30, bitrate: "4M" })).toContain("key-int-max=30");
    expect(buildWaylandCaptureArgs(1, GPU, { fps: 60, bitrate: "6M" })).toContain("key-int-max=60");
  });

  it("keeps conversion and encoding on the same side of the PCIe bus", () => {
    const gpu = buildWaylandCaptureArgs(1, GPU, { fps: 30, bitrate: "4M" }).join(" ");
    expect(gpu).toContain("vapostproc");
    expect(gpu).toContain("video/x-raw(memory:VAMemory),format=NV12");
    expect(gpu).toContain("vah264enc");
    // vapostproc feeding x264enc would download every frame back out of VA memory, which costs
    // more than the software conversion it replaced.
    expect(gpu).not.toContain("x264enc");

    const sw = buildWaylandCaptureArgs(1, SOFTWARE, { fps: 30, bitrate: "4M" }).join(" ");
    expect(sw).toContain("videoconvert");
    expect(sw).toContain("x264enc");
    expect(sw).not.toContain("vapostproc");
    expect(sw).not.toContain("VAMemory");
  });

  it("asks the software encoder for low latency", () => {
    const sw = buildWaylandCaptureArgs(1, SOFTWARE, { fps: 30, bitrate: "1M" });
    expect(sw).toContain("tune=zerolatency");
    expect(sw).toContain("speed-preset=veryfast");
  });

  it("emits the same Annex-B shape the ffmpeg backend does", () => {
    const a = buildWaylandCaptureArgs(1, GPU, { fps: 30, bitrate: "4M" });
    expect(a).toContain("h264parse");
    expect(a).toContain("video/x-h264,stream-format=byte-stream,alignment=au");
    // `AccessUnitAssembler` parses stdout; a different sink would silently produce no frames.
    expect(a.slice(-2)).toEqual(["fdsink", "fd=1"]);
  });
});

describe("buildWaylandPublishArgs", () => {
  it("remuxes to RTSP over TCP and never re-encodes", () => {
    const a = buildWaylandPublishArgs("/usr/bin/ffmpeg", "rtsp://127.0.0.1:8554/s1");
    // The URL is the last element, so the flags sit one in from the end.
    expect(a.slice(-5, -1)).toEqual(["-f", "rtsp", "-rtsp_transport", "tcp"]);
    expect(a[a.length - 1]).toBe("rtsp://127.0.0.1:8554/s1");
    // The whole point of the relay is that it repackages what was already encoded. A `-c:v`
    // other than copy would put a second H.264 encode on the critical path.
    expect(a.join(" ")).toContain("-c:v copy");
    expect(a).toContain("pipe:0");
  });
});
