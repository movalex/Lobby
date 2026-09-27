// The end-of-timer sound: Draftroom's own, synthesized with WebAudio (no audio files, no Miro chime).
// A soft rising three-note bell. Browsers only allow audio after a user gesture, so the context is
// created/resumed on the first pointer or key press anywhere; before that the chime is skipped and
// the visual alert alone plays. Each person can mute it (remembered in this browser).

const MUTE_KEY = 'draftroom:workshop:muted'

export function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1'
  } catch {
    return false
  }
}

export function writeMuted(muted: boolean) {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0')
  } catch {
    // not persisted: applies to this tab only
  }
}

type AudioCtor = typeof AudioContext
let ctx: AudioContext | null = null
let unlockInstalled = false

function audioCtor(): AudioCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

/** Installs a one-time listener that unlocks audio on the first user gesture. */
export function installAudioUnlock() {
  if (unlockInstalled || typeof document === 'undefined') return
  unlockInstalled = true
  const unlock = () => {
    const Ctor = audioCtor()
    if (!Ctor) return
    try {
      ctx ??= new Ctor()
      if (ctx.state === 'suspended') void ctx.resume()
    } catch {
      ctx = null
    }
    if (ctx?.state === 'running') {
      document.removeEventListener('pointerdown', unlock, true)
      document.removeEventListener('keydown', unlock, true)
    }
  }
  document.addEventListener('pointerdown', unlock, true)
  document.addEventListener('keydown', unlock, true)
}

/** The three notes (Hz) and when each starts (s): a gentle major-sixth arpeggio. */
export const CHIME_NOTES: readonly { freq: number; at: number }[] = [
  { freq: 587.33, at: 0 }, // D5
  { freq: 739.99, at: 0.18 }, // F#5
  { freq: 987.77, at: 0.36 }, // B5
]

/** Plays the chime unless muted or audio is still locked. Returns whether it played. */
export function playChime(opts: { muted: boolean }): boolean {
  if (opts.muted || !ctx || ctx.state !== 'running') return false
  try {
    const t0 = ctx.currentTime + 0.02
    const master = ctx.createGain()
    master.gain.value = 0.18
    master.connect(ctx.destination)
    for (const n of CHIME_NOTES) {
      for (const [mult, level] of [
        [1, 1],
        [2.01, 0.25], // a quiet overtone makes it bell-like
      ] as const) {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = n.freq * mult
        const start = t0 + n.at
        gain.gain.setValueAtTime(0.0001, start)
        gain.gain.exponentialRampToValueAtTime(level, start + 0.015)
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.4)
        osc.connect(gain).connect(master)
        osc.start(start)
        osc.stop(start + 1.5)
      }
    }
    return true
  } catch {
    return false
  }
}
