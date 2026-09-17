/**
 * The chosen rung is remembered per *device*, and what comes back out of storage is untrusted.
 *
 * It stays device-local (`persistDevicePref`, never the server round-trip): the rung answers
 * "what can this screen and this link afford", so a desktop on a LAN must not choose
 * "Good image quality" for a phone on mobile data.
 *
 * The load-bearing case is the last one. The ladder used to be five rungs named after
 * resolutions (`tiny`…`max`) plus an `auto` arm, and those strings are still sitting in the
 * localStorage of every device that ever opened the viewer. None of them is a rung any more, so
 * they have to land on the default rather than index `QUALITY_PRESETS` with a key it does not
 * have — which would hand the capture pipeline an `undefined` ratio.
 *
 * Tested through the shared pure function rather than the store, because importing the store
 * reads `localStorage` at module scope and throws under `bun:test`.
 */
import { describe, it, expect } from "bun:test";
import {
  DEFAULT_PRESET_ID, QUALITY_PRESETS, QUALITY_PRESET_ORDER, parsePresetId, parseQualityChoice,
} from "../../../src/shared/remote-desktop-quality";

describe("parseQualityChoice — restoring a remembered rung", () => {
  it("gives back every real rung unchanged", () => {
    for (const id of QUALITY_PRESET_ORDER) expect(parseQualityChoice(id)).toBe(id);
  });

  it("keeps custom as custom, rather than collapsing it to a rung", () => {
    expect(parseQualityChoice("custom")).toBe("custom");
  });

  it("falls back to the default rung when nothing was ever picked", () => {
    expect(parseQualityChoice(undefined)).toBe(DEFAULT_PRESET_ID);
    expect(parseQualityChoice(null)).toBe(DEFAULT_PRESET_ID);
  });

  it("refuses a value localStorage was hand-edited to", () => {
    // Same hazard as a preset id off the wire: with a prototype-walking check, "toString" would
    // pass and `QUALITY_PRESETS["toString"]` would hand the capture pipeline a *function*.
    for (const bad of ["toString", "constructor", "valueOf", "__proto__", "hasOwnProperty"]) {
      expect(parseQualityChoice(bad)).toBe(DEFAULT_PRESET_ID);
    }
  });

  it("refuses anything that is not a rung id at all", () => {
    for (const bad of ["1080p", "BEST", "", " best", 7, {}, [], true]) {
      expect(parseQualityChoice(bad)).toBe(DEFAULT_PRESET_ID);
    }
  });

  it("retires the old five-rung ladder's ids instead of resolving them", () => {
    // Every one of these is a real value sitting in some device's localStorage today.
    for (const gone of ["tiny", "low2", "high", "max", "auto"]) {
      expect(parsePresetId(gone)).toBeNull();
      expect(parseQualityChoice(gone)).toBe(DEFAULT_PRESET_ID);
    }
    // `low` is the one name the two ladders share, and in the new one it is a real rung.
    expect(parseQualityChoice("low")).toBe("low");
  });

  it("only ever yields something the ladder can resolve", () => {
    // The pairing the store relies on: the viewer seeds its choice from this with no second
    // check, so anything this returns must have a ratio the capture layer can multiply by.
    for (const value of ["toString", "custom", "max", undefined, 7, "best"]) {
      const choice = parseQualityChoice(value);
      if (choice !== "custom") expect(QUALITY_PRESETS[choice].ratio).toBeGreaterThan(0);
    }
    expect(parsePresetId("custom")).toBeNull(); // `custom` is not itself a rung
  });
});
