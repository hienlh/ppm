/**
 * Wi-Fi on macOS. The arithmetic is pinned against its sources (NetworkManager's
 * signal formula, IEEE channel numbering); the CoreWLAN reader itself is run for
 * real on a Mac, where it must answer or decline without throwing.
 */
import { describe, expect, test } from "bun:test";
import {
  channelFrequencyMHz, createCoreWlanReader, memoWifiStatus, signalPercent, wirelessFacts,
  type DarwinWifiStatus,
} from "../../../../src/services/system-metrics/wifi-darwin.ts";

describe("signalPercent", () => {
  test("is NetworkManager's scale: -40 dBm is full, -100 is empty, truncated", () => {
    expect(signalPercent(-30)).toBe(100);
    expect(signalPercent(-40)).toBe(100);
    expect(signalPercent(-70)).toBe(50);
    // 100 - trunc(41.67): NM truncates, it does not round.
    expect(signalPercent(-65)).toBe(59);
    expect(signalPercent(-100)).toBe(0);
    expect(signalPercent(-120)).toBe(0);
  });
});

describe("channelFrequencyMHz", () => {
  test("follows the channel plan of each band", () => {
    expect(channelFrequencyMHz(1, 1)).toBe(2412);
    expect(channelFrequencyMHz(13, 1)).toBe(2472);
    expect(channelFrequencyMHz(14, 1)).toBe(2484);
    // What IOKit reports for this capture host's association: channel 36, 5180.
    expect(channelFrequencyMHz(36, 2)).toBe(5180);
    expect(channelFrequencyMHz(165, 2)).toBe(5825);
    expect(channelFrequencyMHz(1, 3)).toBe(5955);
    expect(channelFrequencyMHz(2, 3)).toBe(5935);
  });

  test("has no answer for an unknown band or an impossible channel", () => {
    expect(channelFrequencyMHz(36, 0)).toBeUndefined();
    expect(channelFrequencyMHz(0, 2)).toBeUndefined();
    expect(channelFrequencyMHz(15, 1)).toBeUndefined();
  });
});

describe("wirelessFacts", () => {
  test("turns an association into the row's figures", () => {
    expect(wirelessFacts({
      interfaceName: "en0", rssiDbm: -35, transmitRateMbps: 286.5, channel: 36, band: 2, ssid: "Home",
    })).toEqual({ ssid: "Home", signalPercent: 100, frequencyMHz: 5180, linkMbps: 287 });
  });

  test("a radio that is off reports zeroes, which become no figures at all", () => {
    expect(wirelessFacts({ interfaceName: "en0", rssiDbm: 0, noiseDbm: 0, transmitRateMbps: 0 })).toEqual({});
  });
});

describe("memoWifiStatus", () => {
  test("reads at most once per window, and caches a failure for the same window", () => {
    let calls = 0;
    let clock = 0;
    let answer: DarwinWifiStatus | undefined;
    const read = memoWifiStatus(() => {
      calls++;
      return answer;
    }, () => clock, 5000);
    expect(read()).toBeUndefined();
    answer = { interfaceName: "en0" };
    clock = 4999;
    expect(read()).toBeUndefined();
    expect(calls).toBe(1);
    clock = 5000;
    expect(read()).toEqual({ interfaceName: "en0" });
    expect(calls).toBe(2);
  });
});

describe.if(process.platform === "darwin")("createCoreWlanReader on this Mac", () => {
  test("answers for a real interface or declines, and never throws", () => {
    const status = createCoreWlanReader()();
    if (status === undefined) return;
    expect(status.interfaceName).toMatch(/^en\d+$/);
    if (status.rssiDbm !== undefined && status.rssiDbm !== 0) {
      expect(status.rssiDbm).toBeLessThan(0);
      expect(status.rssiDbm).toBeGreaterThan(-120);
    }
  });
});
