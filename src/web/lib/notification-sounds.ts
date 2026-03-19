let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

function playTone(freq: number, duration: number, startTime: number, gain: number, type: OscillatorType = "sine") {
  const ctx = getAudioContext();
  const osc = ctx.createOscillator();
  const vol = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  vol.gain.setValueAtTime(gain, startTime);
  vol.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
  osc.connect(vol);
  vol.connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

/** Chat completed — pleasant double chime ascending */
function playDone() {
  const ctx = getAudioContext();
  const t = ctx.currentTime;
  playTone(523, 0.15, t, 0.15);        // C5
  playTone(659, 0.2, t + 0.12, 0.15);  // E5
}

/** Approval request — urgent two-tone alert */
function playApproval() {
  const ctx = getAudioContext();
  const t = ctx.currentTime;
  playTone(880, 0.12, t, 0.18, "square");       // A5
  playTone(698, 0.12, t + 0.15, 0.18, "square"); // F5
  playTone(880, 0.15, t + 0.3, 0.15, "square");  // A5
}

/** Question — soft ascending triplet */
function playQuestion() {
  const ctx = getAudioContext();
  const t = ctx.currentTime;
  playTone(440, 0.12, t, 0.12);        // A4
  playTone(523, 0.12, t + 0.1, 0.12);  // C5
  playTone(659, 0.18, t + 0.2, 0.12);  // E5
}

const SOUND_MAP: Record<string, () => void> = {
  done: playDone,
  approval_request: playApproval,
  question: playQuestion,
};

/** Play notification sound by type. No-op if type unknown or AudioContext unavailable. */
export function playNotificationSound(type: string): void {
  try {
    SOUND_MAP[type]?.();
  } catch {
    // AudioContext may be blocked if no user gesture yet — silently ignore
  }
}
