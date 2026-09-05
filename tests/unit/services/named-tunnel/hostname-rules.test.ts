import { describe, test, expect } from "bun:test";
import { proposeHostname, buildHostname, validateHostname } from "../../../../src/services/named-tunnel/hostname-rules.ts";

const ZONE = "hienle.tech";

describe("hostname-rules", () => {
  test("proposeHostname suggests ppm.<zone>", () => {
    expect(proposeHostname(ZONE)).toBe("ppm.hienle.tech");
  });

  test("buildHostname combines prefix + zone, lowercased", () => {
    expect(buildHostname("MyApp", "HIENLE.TECH")).toBe("myapp.hienle.tech");
  });

  test("valid one-label hostname passes", () => {
    expect(validateHostname("ppm.hienle.tech", ZONE)).toEqual({ ok: true });
  });

  test("rejects the zone apex", () => {
    expect(validateHostname("hienle.tech", ZONE).ok).toBe(false);
  });

  test("rejects www", () => {
    expect(validateHostname("www.hienle.tech", ZONE).ok).toBe(false);
  });

  test("rejects two labels above the zone", () => {
    expect(validateHostname("dev.ppm.hienle.tech", ZONE).ok).toBe(false);
  });

  test("rejects a cross-zone hostname even when label counts coincide", () => {
    // cloudflared would silently append the zone instead of erroring (probe #3e) —
    // PPM must refuse before ever calling `route dns` with this.
    expect(validateHostname("ppm-probe.ppm.sh", ZONE).ok).toBe(false);
  });

  test("rejects an invalid DNS label", () => {
    expect(validateHostname("-bad-.hienle.tech", ZONE).ok).toBe(false);
  });

  test("is case-insensitive", () => {
    expect(validateHostname("PPM.HIENLE.TECH", ZONE)).toEqual({ ok: true });
  });
});
