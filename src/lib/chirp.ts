// EchoSense chirp generation and cross-correlation utilities.
// Near-ultrasonic linear sweep chosen to sit near the top of what
// typical phone speakers/mics can reproduce (validated per-device later).

export const CHIRP_START_HZ = 17000;
export const CHIRP_END_HZ = 19500;
export const CHIRP_DURATION_S = 0.006; // 6ms sweep
export const CAPTURE_DURATION_S = 0.25; // listen window after emission (~40m round trip max)

/** Generates a linear-frequency chirp as a Float32Array at the given sample rate. */
export function generateChirp(sampleRate: number): Float32Array {
  const n = Math.round(CHIRP_DURATION_S * sampleRate);
  const chirp = new Float32Array(n);
  const k = (CHIRP_END_HZ - CHIRP_START_HZ) / CHIRP_DURATION_S;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (CHIRP_START_HZ * t + (k * t * t) / 2);
    // Hann window to reduce spectral splatter/clicks
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    chirp[i] = Math.sin(phase) * w;
  }
  return chirp;
}

/** Cross-correlates `signal` against `template`, returning the correlation array. */
export function crossCorrelate(signal: Float32Array, template: Float32Array): Float32Array {
  const out = new Float32Array(signal.length - template.length + 1);
  for (let lag = 0; lag < out.length; lag++) {
    let sum = 0;
    for (let i = 0; i < template.length; i++) {
      sum += signal[lag + i] * template[i];
    }
    out[lag] = sum;
  }
  return out;
}

/** Finds the index of the peak absolute value in an array, skipping the first `skip` samples (direct chirp breakthrough). */
export function findPeakIndex(arr: Float32Array, skip = 0): number {
  let maxIdx = skip;
  let maxVal = -Infinity;
  for (let i = skip; i < arr.length; i++) {
    const v = Math.abs(arr[i]);
    if (v > maxVal) {
      maxVal = v;
      maxIdx = i;
    }
  }
  return maxIdx;
}

export const FEATURE_LEN = 3000; // must match training/features.py FEATURE_LEN

/**
 * Cross-correlation feature vector fed to the 1D CNN, matching
 * training/features.py extract_features exactly: skip past the direct
 * chirp breakthrough, take a fixed-length window, normalize by peak.
 */
export function extractFeatures(
  waveform: Float32Array,
  chirp: Float32Array,
  chirpStartSample: number,
  sampleRate: number
): Float32Array {
  const corr = crossCorrelate(waveform, chirp);
  const guard = Math.round(0.003 * sampleRate);
  const start = chirpStartSample + chirp.length + guard;
  const feat = new Float32Array(FEATURE_LEN);
  for (let i = 0; i < FEATURE_LEN; i++) {
    const srcIdx = start + i;
    feat[i] = srcIdx < corr.length ? corr[srcIdx] : 0;
  }
  let peak = 0;
  for (let i = 0; i < feat.length; i++) {
    const v = Math.abs(feat[i]);
    if (v > peak) peak = v;
  }
  peak += 1e-9;
  for (let i = 0; i < feat.length; i++) feat[i] /= peak;
  return feat;
}

const SPEED_OF_SOUND_M_S = 343;

/** Converts a round-trip sample delay into an estimated distance in meters. */
export function delaySamplesToDistanceM(delaySamples: number, sampleRate: number): number {
  const timeS = delaySamples / sampleRate;
  return (timeS * SPEED_OF_SOUND_M_S) / 2;
}
