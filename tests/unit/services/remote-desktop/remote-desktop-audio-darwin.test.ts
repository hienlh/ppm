/**
 * Which avfoundation input a Mac captures its own output from.
 *
 * The fixture is the real `ffmpeg -f avfoundation -list_devices true` output of the dev host
 * this was built on, kept verbatim: it is what makes the picker's one hard case testable at
 * all. That host has three loopback drivers and only one of them is a general-purpose one, so
 * "it found a loopback" is not the assertion — "it found the *right* loopback" is.
 */
import { describe, it, expect } from "bun:test";
import {
  darwinAudioInputArgs,
} from "../../../../src/services/remote-desktop/remote-desktop-audio.ts";
import {
  parseAvfoundationAudioDevices,
  parseDefaultAudioOutput,
  pickLoopbackDevice,
  routingRefusal,
} from "../../../../src/services/remote-desktop/remote-desktop-audio-darwin.ts";

/** Verbatim from the dev host (Apple silicon, macOS 15), including the two Continuity Camera
 *  warnings ffmpeg writes to the same stream. */
const REAL_LISTING = `2026-10-01 03:16:44.962 ffmpeg[56374:9043118] WARNING: Add NSCameraUseContinuityCameraDeviceType to your Info.plist to use AVCaptureDeviceTypeContinuityCamera.
[AVFoundation indev @ 0x150604290] AVFoundation video devices:
[AVFoundation indev @ 0x150604290] [0] FaceTime HD Camera
[AVFoundation indev @ 0x150604290] [1] # Camera
[AVFoundation indev @ 0x150604290] [2] # Desk View Camera
[AVFoundation indev @ 0x150604290] [3] Capture screen 0
[AVFoundation indev @ 0x150604290] AVFoundation audio devices:
[AVFoundation indev @ 0x150604290] [0] Background Music
[AVFoundation indev @ 0x150604290] [1] Messenger Loopback Audio
[AVFoundation indev @ 0x150604290] [2] MacBook Pro Microphone
[AVFoundation indev @ 0x150604290] [3] Background Music (UI Sounds)
[AVFoundation indev @ 0x150604290] [4] Microsoft Teams Audio
[AVFoundation indev @ 0x150604290] [5] NoMachine Microphone Adapter
[AVFoundation indev @ 0x150604290] [6] NoMachine Audio Adapter
[AVFoundation indev @ 0x150604290] [7] # Microphone
[in#0 @ 0x150604940] Error opening input: Input/output error`;

describe("parseAvfoundationAudioDevices", () => {
  it("takes the audio section only, never the video one", () => {
    const devices = parseAvfoundationAudioDevices(REAL_LISTING);
    expect(devices).toHaveLength(8);
    expect(devices[0]).toEqual({ index: 0, name: "Background Music" });
    expect(devices.map((d) => d.name)).not.toContain("FaceTime HD Camera");
    // Both sections number from 0, so an index-range heuristic would have offered a camera.
    expect(devices.map((d) => d.name)).not.toContain("Capture screen 0");
  });

  it("keeps names with spaces and brackets intact", () => {
    const devices = parseAvfoundationAudioDevices(REAL_LISTING);
    expect(devices[3]).toEqual({ index: 3, name: "Background Music (UI Sounds)" });
  });

  it("answers empty for output with no audio section", () => {
    expect(parseAvfoundationAudioDevices("")).toEqual([]);
    expect(parseAvfoundationAudioDevices("[AVFoundation indev @ 0x1] AVFoundation video devices:\n"
      + "[AVFoundation indev @ 0x1] [0] FaceTime HD Camera")).toEqual([]);
  });
});

describe("pickLoopbackDevice", () => {
  it("prefers a general-purpose loopback over another application's", () => {
    // The regression this file exists for: matched as a *substring*, "loopback audio" hit
    // "Messenger Loopback Audio" — a device that carries Messenger's audio or nothing — and
    // that is what the finished code picked on its first real run.
    const picked = pickLoopbackDevice(parseAvfoundationAudioDevices(REAL_LISTING));
    expect(picked?.name).toBe("Background Music");
  });

  it("never picks an application's own screen-sharing loopback", () => {
    const devices = [
      { index: 0, name: "MacBook Pro Microphone" },
      { index: 1, name: "Messenger Loopback Audio" },
      { index: 2, name: "Microsoft Teams Audio" },
      { index: 3, name: "NoMachine Audio Adapter" },
    ];
    expect(pickLoopbackDevice(devices)).toBeNull();
  });

  it("ranks BlackHole above the others and matches its channel variants", () => {
    const devices = [
      { index: 0, name: "Background Music" },
      { index: 1, name: "BlackHole 16ch" },
      { index: 2, name: "Soundflower (2ch)" },
    ];
    expect(pickLoopbackDevice(devices)?.name).toBe("BlackHole 16ch");
  });

  it("takes the first device of the winning family, not a derived one", () => {
    // "Background Music (UI Sounds)" carries only interface sounds; the plain device is the one
    // that carries everything, and it is listed first.
    const devices = [
      { index: 0, name: "Background Music" },
      { index: 1, name: "Background Music (UI Sounds)" },
    ];
    expect(pickLoopbackDevice(devices)?.index).toBe(0);
  });

  it("answers null for a Mac with no loopback driver at all", () => {
    expect(pickLoopbackDevice([{ index: 0, name: "MacBook Pro Microphone" }])).toBeNull();
  });
});

describe("darwinAudioInputArgs", () => {
  it("addresses the device by name behind the video/audio colon", () => {
    // Without the colon ffmpeg looks for a *video* device of that name; by index instead of
    // name, the list reordering when a Continuity Camera joins would pick another device.
    expect(darwinAudioInputArgs("BlackHole 2ch")).toEqual(["-f", "avfoundation", "-i", ":BlackHole 2ch"]);
  });
});

/** Verbatim shape of `system_profiler SPAudioDataType -json` on the dev host, trimmed to the
 *  fields the parser reads. The real report nests the devices one level down, which is the
 *  reason the parser walks rather than indexing. */
const REAL_REPORT = {
  SPAudioDataType: [{
    _name: "coreaudio_device",
    _items: [
      { _name: "Background Music", coreaudio_device_transport: "coreaudio_device_type_virtual" },
      {
        _name: "MacBook Pro Speakers",
        coreaudio_default_audio_output_device: "spaudio_yes",
        coreaudio_default_audio_system_device: "spaudio_yes",
        coreaudio_device_transport: "coreaudio_device_type_builtin",
      },
      { _name: "Messenger Loopback Audio", coreaudio_device_transport: "coreaudio_device_type_virtual" },
    ],
  }],
};

describe("parseDefaultAudioOutput", () => {
  it("finds the flagged device however the report nests it", () => {
    expect(parseDefaultAudioOutput(REAL_REPORT)).toEqual({
      name: "MacBook Pro Speakers",
      transport: "coreaudio_device_type_builtin",
    });
  });

  it("answers null when nothing is flagged", () => {
    expect(parseDefaultAudioOutput({ SPAudioDataType: [{ _items: [{ _name: "BlackHole 2ch" }] }] })).toBeNull();
    expect(parseDefaultAudioOutput({})).toBeNull();
    expect(parseDefaultAudioOutput(null)).toBeNull();
  });
});

describe("routingRefusal", () => {
  it("refuses when the host plays through real hardware, and names it", () => {
    // The measured state of this dev host: the Background Music driver outlived its app, so the
    // device existed, was picked, and carried 1.5 KB/s of silence whether or not sound played.
    const refusal = routingRefusal("Background Music", parseDefaultAudioOutput(REAL_REPORT));
    expect(refusal).toContain("MacBook Pro Speakers");
    expect(refusal).toContain("Multi-Output Device");
  });

  it("allows it when the loopback is itself the output", () => {
    expect(routingRefusal("BlackHole 2ch", {
      name: "BlackHole 2ch", transport: "coreaudio_device_type_virtual",
    })).toBeNull();
  });

  it("allows an aggregate or Multi-Output Device, which is named after neither", () => {
    // The normal way to both hear the host and capture it. Its transport is not in the physical
    // set, so it must fall through to "cannot tell" rather than being refused on the name.
    expect(routingRefusal("BlackHole 2ch", {
      name: "Multi-Output Device", transport: "coreaudio_device_type_aggregate",
    })).toBeNull();
  });

  it("allows an unrecognised transport rather than guessing", () => {
    expect(routingRefusal("BlackHole 2ch", { name: "Something New", transport: "coreaudio_device_type_future" })).toBeNull();
    expect(routingRefusal("BlackHole 2ch", { name: "Something New", transport: null })).toBeNull();
  });

  it("allows it when the output cannot be read at all", () => {
    expect(routingRefusal("BlackHole 2ch", null)).toBeNull();
  });

  it("refuses a USB headset too, not just the built-in speakers", () => {
    expect(routingRefusal("BlackHole 2ch", {
      name: "Jabra Evolve", transport: "coreaudio_device_type_usb",
    })).toContain("Jabra Evolve");
  });
});
