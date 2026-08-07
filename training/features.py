"""
Feature extraction shared conceptually with src/lib/chirp.ts crossCorrelate/
findPeakIndex: turns a raw captured waveform into the fixed-length
cross-correlation feature vector the 1D CNN consumes. Kept as plain numpy so
it is easy to port 1:1 to the on-device/browser inference path later.
"""

import numpy as np

FEATURE_LEN = 3000  # covers ~10.7m one-way range at 48kHz, well beyond training distances


def cross_correlate(signal: np.ndarray, template: np.ndarray) -> np.ndarray:
    # 'valid' correlation via FFT is much faster than a naive O(n*m) loop for n=12000.
    return np.correlate(signal, template, mode="valid").astype(np.float32)


def extract_features(waveform: np.ndarray, chirp: np.ndarray, chirp_start_sample: int) -> np.ndarray:
    corr = cross_correlate(waveform, chirp)
    guard = int(round(0.003 * 48000))  # skip past the direct chirp breakthrough
    start = chirp_start_sample + len(chirp) + guard
    end = start + FEATURE_LEN
    feat = np.zeros(FEATURE_LEN, dtype=np.float32)
    available = corr[start:min(end, len(corr))]
    feat[: len(available)] = available
    peak = np.max(np.abs(feat)) + 1e-9
    return feat / peak


def batch_extract_features(waveforms: np.ndarray, chirp: np.ndarray, chirp_start_sample: int) -> np.ndarray:
    return np.stack([extract_features(w, chirp, chirp_start_sample) for w in waveforms])
