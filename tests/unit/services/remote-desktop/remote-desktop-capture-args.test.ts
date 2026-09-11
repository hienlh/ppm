import { describe, it, expect } from "bun:test";
import { buildCaptureArgs } from "../../../../src/services/remote-desktop/remote-desktop-capture.ts";
import { captureEncoderArgs } from "../../../../src/services/remote-desktop/remote-desktop-encoder-args.ts";
import { captureInputArgs, captureInputForPlatform } from "../../../../src/services/remote-desktop/remote-desktop-capture-input.ts";
import { QUALITY_PRESETS } from "../../../../src/services/remote-desktop/remote-desktop-quality.ts";

describe("buildCaptureArgs", () => {
  it("captures the desktop via gdigrab into an Annex-B H.264 pipe", () => {
    const args = buildCaptureArgs("/usr/bin/ffmpeg");
    expect(args[0]).toBe("/usr/bin/ffmpeg");
    expect(args).toContain("gdigrab");
    const i = args.indexOf("-i");
    expect(args[i + 1]).toBe("desktop");
    expect(args).toContain("libx264");
    expect(args).toContain("zerolatency");
    expect(args.at(-3)).toBe("-f");
    expect(args.at(-2)).toBe("h264");
    expect(args.at(-1)).toBe("pipe:1");
  });

  it("forces -bf 0 so every frame is exactly one VCL NAL (AU-assembly assumption)", () => {
    const args = buildCaptureArgs("ffmpeg");
    const bf = args.indexOf("-bf");
    expect(args[bf + 1]).toBe("0");
  });

  it("adds low-latency demux/mux flags so ffmpeg does not buffer frames before emitting", () => {
    const args = buildCaptureArgs("ffmpeg");
    const nb = args.indexOf("-fflags");
    expect(args[nb + 1]).toBe("nobuffer");
    const fp = args.indexOf("-flush_packets");
    expect(args[fp + 1]).toBe("1");
  });

  it("uses the detected hardware encoder args when one is passed", () => {
    const args = buildCaptureArgs("ffmpeg", "h264_nvenc");
    expect(args).toContain("h264_nvenc");
    expect(args).not.toContain("libx264");
  });

  it("captures a macOS screen via avfoundation by device NAME (indices shift at runtime), cursor included", () => {
    const args = buildCaptureArgs("ffmpeg", "h264_videotoolbox", { kind: "avfoundation", screen: "Capture screen 0" });
    expect(args).toContain("avfoundation");
    expect(args).not.toContain("gdigrab");
    expect(args[args.indexOf("-i") + 1]).toBe("Capture screen 0");
    expect(args[args.indexOf("-capture_cursor") + 1]).toBe("1");
    expect(args[args.indexOf("-pixel_format") + 1]).toBe("nv12");
    expect(args).toContain("h264_videotoolbox");
  });

  it("caps avfoundation to the target frame rate (device ignores -framerate, delivers at refresh rate)", () => {
    const args = buildCaptureArgs("ffmpeg", "h264_videotoolbox", { kind: "avfoundation", screen: "Capture screen 0" });
    expect(args[args.indexOf("-use_wallclock_as_timestamps") + 1]).toBe("1");
    expect(args[args.indexOf("-vf") + 1]).toBe("fps=30");
    // gdigrab honours -framerate and a rung no longer scales, so it has nothing left to filter
    // at all — and `-vf ""` is rejected by ffmpeg rather than ignored, so the flag must be gone.
    expect(buildCaptureArgs("ffmpeg")).not.toContain("-vf");
  });
});

describe("captureInputForPlatform", () => {
  const x11 = { kind: "x11" as const, display: ":0", xauthority: null };
  const wayland = { kind: "wayland" as const, display: "wayland-0", runtimeDir: "/run/user/1000" };

  it("maps win32 → gdigrab, darwin → avfoundation main screen by name, unknown → null", () => {
    expect(captureInputForPlatform("win32")).toEqual({ kind: "gdigrab" });
    expect(captureInputForPlatform("darwin")).toEqual({ kind: "avfoundation", screen: "Capture screen 0" });
    expect(captureInputForPlatform("freebsd")).toBeNull();
  });

  it("maps an X11 session to x11grab and a display-less host to null", () => {
    expect(captureInputForPlatform("linux", 0, { session: x11 }))
      .toEqual({ kind: "x11grab", display: ":0", rect: null });
    // A headless server / CI container has no session at all.
    expect(captureInputForPlatform("linux", 0, { session: null })).toBeNull();
  });

  it("has no grabber for Wayland yet — capture there needs the desktop portal", () => {
    expect(captureInputForPlatform("linux", 0, { session: wayland })).toBeNull();
  });
});

describe("buildCaptureArgs — x11grab", () => {
  const input = { kind: "x11grab" as const, display: ":0", rect: { x: 1920, y: 0, width: 2560, height: 1440 } };

  it("crops one monitor out of the X root window and keeps the cursor", () => {
    const args = buildCaptureArgs("ffmpeg", "libx264", input);
    expect(args).toContain("x11grab");
    expect(args[args.indexOf("-video_size") + 1]).toBe("2560x1440");
    // X11 puts every monitor in one root coordinate space, so the offset is what picks one.
    expect(args[args.indexOf("-i") + 1]).toBe(":0.0+1920,0");
    expect(args[args.indexOf("-draw_mouse") + 1]).toBe("1");
  });

  it("grabs the whole root window when no rect is given, and honours -framerate", () => {
    const args = buildCaptureArgs("ffmpeg", "libx264", { kind: "x11grab", display: ":0", rect: null });
    expect(args[args.indexOf("-i") + 1]).toBe(":0.0");
    expect(args).not.toContain("-video_size");
    // Unlike avfoundation the grabber honours -framerate, so no fps filter is needed — and with
    // no scale step either, there is no filtergraph to pass.
    expect(args).not.toContain("-vf");
    expect(args[args.indexOf("-framerate") + 1]).toBe("30");
  });

  it("does not double the screen number when DISPLAY already carries one", () => {
    const args = buildCaptureArgs("ffmpeg", "libx264", { kind: "x11grab", display: ":0.0", rect: null });
    expect(args[args.indexOf("-i") + 1]).toBe(":0.0");
  });

  it("opens the VAAPI device before -i and uploads frames in the same -vf chain", () => {
    const args = buildCaptureArgs("ffmpeg", "h264_vaapi", input);
    // `-vaapi_device` after `-i` is accepted by argv parsing and then fails at runtime.
    expect(args.indexOf("-vaapi_device")).toBeLessThan(args.indexOf("-i"));
    expect(args[args.indexOf("-vf") + 1]).toBe("format=nv12,hwupload");
    // Exactly one -vf: a second occurrence replaces the first instead of combining.
    expect(args.filter((a) => a === "-vf")).toHaveLength(1);
    // A software pixel format on the output makes ffmpeg reject the hardware frame context.
    expect(args).not.toContain("-pix_fmt");
  });
});

describe("captureInputArgs — the remote cursor", () => {
  const GDI = { kind: "gdigrab" as const };
  const X11 = { kind: "x11grab" as const, display: ":0", rect: null };
  const AVF = { kind: "avfoundation" as const, screen: "Capture screen 0" };

  it("draws the host pointer by default on every grabber", () => {
    for (const input of [GDI, X11] as const) {
      const args = captureInputArgs(input);
      expect(args[args.indexOf("-draw_mouse") + 1]).toBe("1");
    }
    const avf = captureInputArgs(AVF);
    expect(avf[avf.indexOf("-capture_cursor") + 1]).toBe("1");
  });

  it("hides it on every grabber, under each grabber's own flag name", () => {
    // The flag is not spelled the same everywhere, and a grabber that silently kept its
    // default would leave the pointer on screen with the menu item ticked off.
    for (const input of [GDI, X11] as const) {
      const args = captureInputArgs(input, QUALITY_PRESETS.balanced, false);
      expect(args[args.indexOf("-draw_mouse") + 1]).toBe("0");
      expect(args).not.toContain("-capture_cursor");
    }
    const avf = captureInputArgs(AVF, QUALITY_PRESETS.balanced, false);
    expect(avf[avf.indexOf("-capture_cursor") + 1]).toBe("0");
    expect(avf).not.toContain("-draw_mouse");
  });

  it("reaches the spawned argv through buildCaptureArgs", () => {
    const on = buildCaptureArgs("ffmpeg", "libx264", X11, QUALITY_PRESETS.balanced, true);
    const off = buildCaptureArgs("ffmpeg", "libx264", X11, QUALITY_PRESETS.balanced, false);
    expect(on[on.indexOf("-draw_mouse") + 1]).toBe("1");
    expect(off[off.indexOf("-draw_mouse") + 1]).toBe("0");
  });
});

describe("captureEncoderArgs", () => {
  it("emits low-latency NVENC args for h264_nvenc (still -bf 0 for one slice/frame)", () => {
    const a = captureEncoderArgs("h264_nvenc");
    expect(a).toEqual(expect.arrayContaining(["-c:v", "h264_nvenc", "-tune", "ll", "-rc", "cbr"]));
    expect(a[a.indexOf("-bf") + 1]).toBe("0");
  });

  it("falls back to low-latency libx264 with sliced-threads disabled when no hw encoder", () => {
    const a = captureEncoderArgs();
    expect(a).toContain("libx264");
    expect(a).toContain("zerolatency");
    expect(a.join(" ")).toContain("sliced-threads=0");
  });
});
