"""
Synthetic chirp-echo simulator for EchoSense.

Generates labeled training samples that match exactly what the browser
data-collection tool (src/lib/chirp.ts + src/lib/echoEngine.ts) captures:
a 17-19.5kHz, 6ms linear chirp emitted 20ms into a 250ms recording window,
at 48kHz sample rate. Each sample is a raw microphone waveform containing
the direct chirp breakthrough plus a class-specific echo signature.

No public dataset exists for "phone speaker/mic echo classified by obstacle
type" (verified by search) so this simulator bootstraps training. Real
samples collected via the /collect tool are used later to fine-tune,
since real echoes will not perfectly match this physics approximation.
"""

import json
import numpy as np

SAMPLE_RATE = 48000
CHIRP_START_HZ = 17000
CHIRP_END_HZ = 19500
CHIRP_DURATION_S = 0.006
CAPTURE_DURATION_S = 0.25
CHIRP_DELAY_S = 0.02
SPEED_OF_SOUND_M_S = 343.0

LABELS = ["wall", "person", "doorway", "stairs", "none"]


def generate_chirp(sample_rate=SAMPLE_RATE):
    n = round(CHIRP_DURATION_S * sample_rate)
    t = np.arange(n) / sample_rate
    k = (CHIRP_END_HZ - CHIRP_START_HZ) / CHIRP_DURATION_S
    phase = 2 * np.pi * (CHIRP_START_HZ * t + 0.5 * k * t**2)
    window = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(n) / (n - 1))
    return (np.sin(phase) * window).astype(np.float32)


def distance_to_delay_samples(distance_m, sample_rate=SAMPLE_RATE):
    return (2 * distance_m / SPEED_OF_SOUND_M_S) * sample_rate


def add_echo(waveform, chirp, start_sample, amplitude, lowpass_alpha=1.0, smear_samples=0):
    """Adds a (possibly attenuated/filtered/smeared) copy of the chirp into waveform at start_sample."""
    echo = chirp.copy() * amplitude

    if lowpass_alpha < 1.0:
        # Simple one-pole low-pass to model high-frequency absorption (soft materials).
        filtered = np.zeros_like(echo)
        prev = 0.0
        for i in range(len(echo)):
            prev = lowpass_alpha * echo[i] + (1 - lowpass_alpha) * prev
            filtered[i] = prev
        echo = filtered

    if smear_samples > 0:
        # Convolve with a short decaying kernel to model diffuse (soft-tissue) reflection.
        kernel = np.exp(-np.arange(smear_samples) / (smear_samples / 3))
        kernel /= kernel.sum()
        echo = np.convolve(echo, kernel, mode="full")[: len(chirp) + smear_samples]

    start = int(round(start_sample))
    end = start + len(echo)
    if start >= len(waveform):
        return
    end = min(end, len(waveform))
    if end <= start:
        return
    waveform[start:end] += echo[: end - start]


def synthesize_sample(label, distance_m, sample_rate=SAMPLE_RATE, snr_db=None, rng=None):
    rng = rng or np.random.default_rng()
    chirp = generate_chirp(sample_rate)
    capture_len = round(CAPTURE_DURATION_S * sample_rate)
    chirp_start_sample = round(CHIRP_DELAY_S * sample_rate)

    waveform = np.zeros(capture_len, dtype=np.float32)

    # Direct breakthrough: speaker bleeding straight into the mic before any reflection.
    add_echo(waveform, chirp, chirp_start_sample, amplitude=rng.uniform(0.25, 0.4))

    base_delay = chirp_start_sample + len(chirp) + distance_to_delay_samples(distance_m, sample_rate)
    # Distance-based attenuation (inverse-square-ish, softened for numerical stability).
    base_amp = 1.0 / (1.0 + (distance_m / 1.5) ** 1.7)

    if label == "wall":
        amp = base_amp * rng.uniform(0.85, 1.0)
        add_echo(waveform, chirp, base_delay, amplitude=amp, lowpass_alpha=1.0, smear_samples=0)

    elif label == "person":
        amp = base_amp * rng.uniform(0.35, 0.55)
        add_echo(waveform, chirp, base_delay, amplitude=amp, lowpass_alpha=0.35, smear_samples=25)

    elif label == "doorway":
        # Weak/partial primary reflection (edge of frame), stronger secondary echo from a
        # wall further behind the opening.
        amp = base_amp * rng.uniform(0.05, 0.18)
        add_echo(waveform, chirp, base_delay, amplitude=amp, lowpass_alpha=0.8)
        far_distance = distance_m + rng.uniform(1.0, 3.0)
        far_delay = chirp_start_sample + len(chirp) + distance_to_delay_samples(far_distance, sample_rate)
        far_amp = (1.0 / (1.0 + (far_distance / 1.5) ** 1.7)) * rng.uniform(0.5, 0.8)
        add_echo(waveform, chirp, far_delay, amplitude=far_amp, lowpass_alpha=1.0)

    elif label == "stairs":
        n_steps = rng.integers(3, 6)
        step_depth = rng.uniform(0.15, 0.3)
        for i in range(n_steps):
            step_distance = distance_m + i * step_depth
            step_delay = chirp_start_sample + len(chirp) + distance_to_delay_samples(step_distance, sample_rate)
            step_amp = base_amp * (0.9 ** i) * rng.uniform(0.5, 0.85)
            add_echo(waveform, chirp, step_delay, amplitude=step_amp, lowpass_alpha=0.9)

    elif label == "none":
        pass  # no reflective surface within range

    else:
        raise ValueError(f"unknown label {label}")

    if snr_db is None:
        snr_db = rng.uniform(5, 30)
    signal_power = np.mean(waveform**2) + 1e-9
    noise_power = signal_power / (10 ** (snr_db / 10))
    noise = rng.normal(0, np.sqrt(noise_power), size=waveform.shape).astype(np.float32)
    waveform = waveform + noise

    peak = np.max(np.abs(waveform)) + 1e-9
    if peak > 1.0:
        waveform = waveform / peak

    return waveform


def build_dataset(samples_per_label=400, seed=42):
    rng = np.random.default_rng(seed)
    X, y, meta = [], [], []
    for label_idx, label in enumerate(LABELS):
        for _ in range(samples_per_label):
            distance_m = rng.uniform(0.2, 4.0) if label != "none" else rng.uniform(4.0, 8.0)
            snr_db = rng.choice([rng.uniform(15, 30), rng.uniform(3, 12)], p=None)
            waveform = synthesize_sample(label, distance_m, snr_db=snr_db, rng=rng)
            X.append(waveform)
            y.append(label_idx)
            meta.append({"label": label, "distance_m": float(distance_m), "snr_db": float(snr_db)})
    return np.array(X, dtype=np.float32), np.array(y, dtype=np.int64), meta


if __name__ == "__main__":
    X, y, meta = build_dataset(samples_per_label=400)
    print(f"Generated {len(X)} samples, waveform length {X.shape[1]}")
    np.savez_compressed("training/data/synthetic_echosense.npz", X=X, y=y, labels=np.array(LABELS))
    with open("training/data/synthetic_meta.json", "w") as f:
        json.dump(meta, f)
    print("Saved to training/data/synthetic_echosense.npz")
