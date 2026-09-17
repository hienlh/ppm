import { describe, it, expect } from "bun:test";
import { OggOpusDemuxer, parseOpusHead } from "../../../../src/services/remote-desktop/remote-desktop-ogg-opus.ts";

/** One Ogg page from an explicit lacing table — the only way to express "this packet is not
 *  finished", which is a *missing* terminator rather than a flag. A 255-byte packet laces as
 *  `255, 0`; the same 255 bytes as the head of a longer one laces as just `255`. */
function rawPage(lacing: number[], payload: number[], flags = 0, seq = 0): Uint8Array {
  const head = [
    0x4f, 0x67, 0x67, 0x53, 0,      // "OggS", version
    flags,
    0, 0, 0, 0, 0, 0, 0, 0,          // granule
    1, 0, 0, 0,                      // serial
    seq, 0, 0, 0,                    // sequence
    0, 0, 0, 0,                      // CRC (not verified)
    lacing.length,
  ];
  return Uint8Array.from([...head, ...lacing, ...payload]);
}

/** One page holding whole packets, laced the way Ogg requires (255,255,…,remainder — with a
 *  trailing 0 when the length is an exact multiple of 255, or the packet reads as unfinished). */
function page(segments: number[][], flags = 0, seq = 0): Uint8Array {
  const lacing: number[] = [];
  const payload: number[] = [];
  for (const seg of segments) {
    let left = seg.length;
    let at = 0;
    for (;;) {
      const take = Math.min(255, left);
      lacing.push(take);
      payload.push(...seg.slice(at, at + take));
      at += take;
      left -= take;
      if (take < 255) break;
    }
  }
  return rawPage(lacing, payload, flags, seq);
}

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

const OPUS_HEAD = [
  ...ascii("OpusHead"), 1, 2, 0x78, 0x00, 0x80, 0xbb, 0x00, 0x00, 0, 0, 0,
];

describe("parseOpusHead", () => {
  it("reads the channel count, pre-skip and input rate", () => {
    // Byte-for-byte the header a real `ffmpeg -c:a libopus -f ogg` wrote on this host.
    expect(parseOpusHead(Uint8Array.from(OPUS_HEAD))).toEqual({
      channels: 2, preSkip: 120, inputSampleRate: 48000,
    });
  });

  it("refuses anything that is not one", () => {
    expect(parseOpusHead(Uint8Array.from(ascii("OpusTags____________")))).toBeNull();
    expect(parseOpusHead(Uint8Array.from(ascii("OpusHea")))).toBeNull(); // too short to check
  });
});

describe("OggOpusDemuxer", () => {
  it("consumes the two header packets and emits only audio", () => {
    const d = new OggOpusDemuxer();
    const out = [
      ...d.push(page([OPUS_HEAD], 0x02)),
      ...d.push(page([[...ascii("OpusTags"), 0, 0, 0, 0]])),
      ...d.push(page([[1, 2, 3], [4, 5]])),
    ];
    expect(d.info).toEqual({ channels: 2, preSkip: 120, inputSampleRate: 48000 });
    expect(out.map((p) => [...p])).toEqual([[1, 2, 3], [4, 5]]);
  });

  it("finds packets however the pipe chops the bytes", () => {
    // The whole point of the class: stdout chunk boundaries have no relation to page ones.
    const stream = new Uint8Array([
      ...page([OPUS_HEAD], 0x02),
      ...page([[...ascii("OpusTags"), 0, 0, 0, 0]]),
      ...page([[9, 9, 9]]),
      ...page([[7, 7]]),
    ]);
    for (const size of [1, 3, 17, 64, stream.length]) {
      const d = new OggOpusDemuxer();
      const out: number[][] = [];
      for (let i = 0; i < stream.length; i += size) {
        for (const p of d.push(stream.subarray(i, i + size))) out.push([...p]);
      }
      expect(out).toEqual([[9, 9, 9], [7, 7]]);
      expect(d.info?.channels).toBe(2);
    }
  });

  it("rejoins a packet split across two pages", () => {
    // 300 bytes laces as 255 + 45, and a packet whose last lacing value is 255 continues on
    // the next page — ignoring that emits a truncated packet, which AudioDecoder reports as a
    // decode error rather than as a click.
    const long = Array.from({ length: 300 }, (_, i) => i & 0xff);
    const d = new OggOpusDemuxer();
    d.push(page([OPUS_HEAD], 0x02));
    // Page 1's lacing ends on 255 with no terminator: the packet is not finished.
    expect(d.push(rawPage([255], long.slice(0, 255)))).toHaveLength(0);
    // Continuation page carries the remaining 45 bytes and closes the packet.
    const out = d.push(rawPage([45], long.slice(255), 0x01, 1));
    expect(out).toHaveLength(1);
    expect([...out[0]!]).toEqual(long);
  });

  it("drops a half packet when the next page is not a continuation", () => {
    // Bytes were lost; half an Opus packet decodes to noise, so it must not be emitted.
    const d = new OggOpusDemuxer();
    d.push(page([OPUS_HEAD], 0x02));
    d.push(rawPage([255], Array.from({ length: 255 }, () => 1)));
    const out = d.push(page([[5, 5]], 0x00, 2));
    expect(out.map((p) => [...p])).toEqual([[5, 5]]);
  });
});
