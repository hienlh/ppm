/**
 * Runs inside every page of PPM's browser, before the page's own scripts, and sends what the
 * page plays to PPM as 16-bit PCM, mono, 24 kHz, about every 85 ms.
 *
 * CDP carries no sound, and capturing the host's output needs a loopback device most Windows
 * machines do not have enabled, so the sound is taken where it is made:
 * - `<audio>`/`<video>`: `captureStream()` taps the element without changing what it plays.
 * - Web Audio: every connection into a context's `destination` is also made into a
 *   `MediaStreamAudioDestinationNode` of that context, whose stream is mixed in.
 * Chrome runs with `--mute-audio`, so the host's speakers stay silent.
 *
 * Written as a real function and shipped with `toString()`, so it is type-checked and tested
 * as code; it may use nothing from outside itself. Silence is not sent.
 */
export function audioTap(bindingName: string): void {
  const w = window as unknown as Record<string, unknown>;
  const send = w[bindingName] as ((payload: string) => void) | undefined;
  if (typeof send !== "function" || w.__ppmAudioTap) return;
  w.__ppmAudioTap = true;
  const RATE = 24000;
  let ctx: AudioContext | null = null;
  let mix: GainNode | null = null;

  const ensure = (): boolean => {
    if (ctx) return true;
    try {
      ctx = new AudioContext({ sampleRate: RATE });
      mix = ctx.createGain();
      const proc = ctx.createScriptProcessor(2048, 1, 1);
      mix.connect(proc);
      proc.connect(ctx.destination);
      proc.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < data.length; i += 8) peak = Math.max(peak, Math.abs(data[i]!));
        if (peak < 0.0005) return;
        const out = new Int16Array(data.length);
        for (let i = 0; i < data.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(data[i]! * 32767)));
        const bytes = new Uint8Array(out.buffer);
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        try { send(btoa(bin)); } catch {}
      };
      void ctx.resume().catch(() => {});
      return true;
    } catch {
      ctx = null;
      return false;
    }
  };

  const addStream = (stream: MediaStream) => {
    if (!ensure() || !ctx || !mix || stream.getAudioTracks().length === 0) return;
    try { ctx.createMediaStreamSource(stream).connect(mix); } catch {}
  };

  const tapped = new WeakSet<HTMLMediaElement>();
  const tapMedia = (el: HTMLMediaElement) => {
    if (tapped.has(el)) return;
    tapped.add(el);
    const capture = (el as HTMLMediaElement & { captureStream?: () => MediaStream }).captureStream;
    if (typeof capture !== "function") return;
    try {
      const stream = capture.call(el);
      if (stream.getAudioTracks().length) addStream(stream);
      stream.addEventListener("addtrack", (ev) => {
        const track = (ev as MediaStreamTrackEvent).track;
        if (track.kind === "audio") addStream(new MediaStream([track]));
      });
    } catch {}
  };
  document.addEventListener("play", (ev) => { if (ev.target instanceof HTMLMediaElement) tapMedia(ev.target); }, true);
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    tapMedia(this);
    return play.call(this);
  };

  const taps = new WeakMap<BaseAudioContext, MediaStreamAudioDestinationNode>();
  const connect = AudioNode.prototype.connect as (this: AudioNode, ...args: unknown[]) => unknown;
  AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
    const result = connect.apply(this, args);
    const target = args[0];
    if (target instanceof AudioDestinationNode && this.context !== ctx) {
      try {
        let tap = taps.get(this.context);
        if (!tap && this.context instanceof AudioContext) {
          tap = this.context.createMediaStreamDestination();
          taps.set(this.context, tap);
          addStream(tap.stream);
        }
        if (tap) connect.call(this, tap);
      } catch {}
    }
    return result;
  } as typeof AudioNode.prototype.connect;
}

/** The script as Chrome evaluates it on every new document. */
export function audioTapSource(bindingName: string): string {
  return `(${audioTap.toString()})(${JSON.stringify(bindingName)});`;
}
