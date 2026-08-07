/**
 * Learned-policy stand-in for the adaptive sense-infer-act-adapt loop: tunes
 * chirp emission gain and polling rate based on how clean recent echo
 * signals have been (peak-to-noise-floor ratio of the correlation feature).
 * A contextual-bandit/RL policy is future work (per the project doc); this
 * is a deterministic controller with the same inputs/outputs so it can be
 * swapped in later without touching the sense/infer/act call sites.
 */

const MIN_GAIN = 0.5;
const MAX_GAIN = 1.0;
const MIN_INTERVAL_MS = 180;
const MAX_INTERVAL_MS = 700;
const GOOD_SIGNAL_RATIO = 6; // peak/noise-floor ratio considered "clean"
const POOR_SIGNAL_RATIO = 2.5;

export interface AdaptiveState {
  gain: number;
  intervalMs: number;
}

export class AdaptiveController {
  private gain = 0.85;
  private intervalMs = 350;
  private emaRatio = GOOD_SIGNAL_RATIO;

  /** Call after each capture with the peak-to-noise-floor ratio of that read. */
  update(signalRatio: number): AdaptiveState {
    this.emaRatio = this.emaRatio * 0.7 + signalRatio * 0.3;

    if (this.emaRatio < POOR_SIGNAL_RATIO) {
      // Weak/noisy signal: emit louder, poll more slowly to average out noise.
      this.gain = Math.min(MAX_GAIN, this.gain + 0.05);
      this.intervalMs = Math.min(MAX_INTERVAL_MS, this.intervalMs + 40);
    } else if (this.emaRatio > GOOD_SIGNAL_RATIO) {
      // Clean signal: back off gain (save power/avoid clipping), poll faster.
      this.gain = Math.max(MIN_GAIN, this.gain - 0.03);
      this.intervalMs = Math.max(MIN_INTERVAL_MS, this.intervalMs - 30);
    }

    return { gain: this.gain, intervalMs: this.intervalMs };
  }

  get state(): AdaptiveState {
    return { gain: this.gain, intervalMs: this.intervalMs };
  }
}

/** Peak-to-noise-floor ratio of a normalized feature vector (median as noise-floor estimate). */
export function signalRatio(feat: Float32Array): number {
  const abs = Array.from(feat, Math.abs).sort((a, b) => a - b);
  const median = abs[Math.floor(abs.length / 2)] + 1e-6;
  const peak = abs[abs.length - 1];
  return peak / median;
}
