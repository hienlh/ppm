/**
 * Groups the raw NAL units from `NalSplitter` into WebCodecs-ready access units.
 *
 * `VideoDecoder` decodes one access unit (one frame) per `EncodedVideoChunk`, not one
 * NAL — feeding SPS/PPS/slice as three separate chunks throws or corrupts decode. libx264
 * (no B-frames, `-bf 0`) emits at most one slice NAL per frame, optionally preceded by
 * SPS/PPS on a keyframe, so an AU boundary is simply "the next VCL NAL after we already
 * buffered one" — everything non-VCL (SPS/PPS/AUD/SEI) that arrived first attaches to the
 * AU it precedes.
 */
import { NalSplitter, nalType, isVclNal, NAL_TYPE_IDR, NAL_TYPE_SPS, NAL_TYPE_PPS } from "./nal-splitter.ts";

export interface AccessUnit {
  /** Annex-B encoded bytes (start codes + NAL payloads) — one `EncodedVideoChunk` worth. */
  bytes: Uint8Array;
  isKey: boolean;
}

const START_CODE = Uint8Array.of(0, 0, 0, 1);

function encodeAnnexB(nals: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const n of nals) total += START_CODE.length + n.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const n of nals) {
    out.set(START_CODE, offset);
    offset += START_CODE.length;
    out.set(n, offset);
    offset += n.length;
  }
  return out;
}

export class AccessUnitAssembler {
  private readonly splitter = new NalSplitter();
  private pending: Uint8Array[] = [];
  private pendingHasVcl = false;
  private sps: Uint8Array | null = null;
  private pps: Uint8Array | null = null;

  /** Feed a raw ffmpeg stdout chunk; returns zero or more completed access units. */
  push(chunk: Uint8Array): AccessUnit[] {
    const aus: AccessUnit[] = [];
    for (const nal of this.splitter.push(chunk)) {
      const type = nalType(nal);
      if (type === NAL_TYPE_SPS) this.sps = nal;
      else if (type === NAL_TYPE_PPS) this.pps = nal;

      const vcl = isVclNal(nal);
      if (vcl && this.pendingHasVcl) {
        const au = this.flush();
        if (au) aus.push(au);
      }
      this.pending.push(nal);
      if (vcl) this.pendingHasVcl = true;
    }
    return aus;
  }

  /** SPS bytes seen so far (NAL header byte included) — used to derive the avc1 codec
   *  string. Null until the encoder has emitted its first keyframe. */
  cachedSps(): Uint8Array | null {
    return this.sps;
  }

  private flush(): AccessUnit | null {
    if (this.pending.length === 0) {
      this.pendingHasVcl = false;
      return null;
    }
    let nals = this.pending;
    const isKey = nals.some((n) => nalType(n) === NAL_TYPE_IDR);
    if (isKey) {
      // A late-joining client (or a client that missed the very first AU) needs SPS+PPS
      // concatenated into the same key chunk it decodes — three separate chunks is not
      // decodable Annex-B input for WebCodecs. Normally libx264 already includes them; this
      // is a defensive backfill from the cache, not the common path.
      const hasSps = nals.some((n) => nalType(n) === NAL_TYPE_SPS);
      const hasPps = nals.some((n) => nalType(n) === NAL_TYPE_PPS);
      const prefix: Uint8Array[] = [];
      if (!hasSps && this.sps) prefix.push(this.sps);
      if (!hasPps && this.pps) prefix.push(this.pps);
      if (prefix.length > 0) nals = [...prefix, ...nals];
    }
    this.pending = [];
    this.pendingHasVcl = false;
    return { bytes: encodeAnnexB(nals), isKey };
  }
}
