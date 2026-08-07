"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { generateChirp, crossCorrelate, findPeakIndex, delaySamplesToDistanceM } from "@/lib/chirp";
import { emitAndCapture, getMicStream } from "@/lib/echoEngine";
import { saveSample, countByLabel, OBSTACLE_LABELS, type ObstacleLabel } from "@/lib/db";

type Status = "idle" | "requesting-mic" | "ready" | "capturing" | "captured" | "error";

export default function CollectPage() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState<ObstacleLabel>("wall");
  const [distanceCm, setDistanceCm] = useState<string>("100");
  const [estimatedDistanceM, setEstimatedDistanceM] = useState<number | null>(null);
  const [peakCorrelation, setPeakCorrelation] = useState<number | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const streamRef = useRef<MediaStream | null>(null);
  const lastCaptureRef = useRef<{ sampleRate: number; waveform: Float32Array } | null>(null);

  const refreshCounts = useCallback(async () => {
    setCounts(await countByLabel());
  }, []);

  useEffect(() => {
    refreshCounts();
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [refreshCounts]);

  const requestMic = async () => {
    setError(null);
    setStatus("requesting-mic");
    try {
      const stream = await getMicStream();
      streamRef.current = stream;
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Microphone permission denied");
      setStatus("error");
    }
  };

  const capture = async () => {
    if (!streamRef.current) return;
    setError(null);
    setStatus("capturing");
    try {
      const result = await emitAndCapture(streamRef.current);
      const chirp = generateChirp(result.sampleRate);
      // Skip past the direct chirp breakthrough so we find the reflected echo peak.
      const skipSamples = result.chirpStartSample + chirp.length + Math.round(0.003 * result.sampleRate);
      const corr = crossCorrelate(result.waveform, chirp);
      const peakIdx = findPeakIndex(corr, skipSamples);
      const delaySamples = peakIdx - result.chirpStartSample;
      const distM = delaySamplesToDistanceM(Math.max(delaySamples, 0), result.sampleRate);
      setEstimatedDistanceM(distM);
      setPeakCorrelation(corr[peakIdx]);
      lastCaptureRef.current = { sampleRate: result.sampleRate, waveform: result.waveform };
      setStatus("captured");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Capture failed");
      setStatus("error");
    }
  };

  const save = async () => {
    if (!lastCaptureRef.current) return;
    const cap = lastCaptureRef.current;
    await saveSample({
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      label,
      groundTruthDistanceCm: Number(distanceCm) || 0,
      sampleRate: cap.sampleRate,
      waveform: Array.from(cap.waveform),
      estimatedDistanceM: estimatedDistanceM ?? -1,
      peakCorrelation: peakCorrelation ?? 0,
      deviceInfo: navigator.userAgent,
    });
    setStatus("ready");
    setEstimatedDistanceM(null);
    setPeakCorrelation(null);
    lastCaptureRef.current = null;
    await refreshCounts();
  };

  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">EchoSense — Data Collection</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Emit a near-ultrasonic chirp, record the echo, label it with the true obstacle type and
          distance. These labeled samples train the 1D CNN obstacle classifier.
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-red-400 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {status === "idle" || status === "requesting-mic" || status === "error" ? (
        <button
          onClick={requestMic}
          disabled={status === "requesting-mic"}
          className="rounded-md bg-black px-4 py-3 font-medium text-white disabled:opacity-50"
        >
          {status === "requesting-mic" ? "Requesting microphone…" : "Enable Microphone"}
        </button>
      ) : (
        <>
          <section className="flex flex-col gap-2">
            <label className="text-sm font-medium">Obstacle type</label>
            <div className="flex flex-wrap gap-2">
              {OBSTACLE_LABELS.map((l) => (
                <button
                  key={l}
                  onClick={() => setLabel(l)}
                  className={`rounded-full border px-3 py-1.5 text-sm capitalize ${
                    label === l ? "border-black bg-black text-white" : "border-neutral-300"
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <label className="text-sm font-medium" htmlFor="distance">
              Ground-truth distance (cm)
            </label>
            <input
              id="distance"
              type="number"
              inputMode="numeric"
              value={distanceCm}
              onChange={(e) => setDistanceCm(e.target.value)}
              className="rounded-md border border-neutral-300 px-3 py-2"
            />
          </section>

          <button
            onClick={capture}
            disabled={status === "capturing"}
            className="rounded-md bg-blue-600 px-4 py-3 font-medium text-white disabled:opacity-50"
          >
            {status === "capturing" ? "Listening…" : "Emit Chirp & Record"}
          </button>

          {status === "captured" && (
            <div className="rounded-md border border-neutral-300 p-3 text-sm">
              <p>
                Estimated distance:{" "}
                <strong>{estimatedDistanceM !== null ? (estimatedDistanceM * 100).toFixed(1) : "—"} cm</strong>
              </p>
              <p className="text-neutral-500">Correlation peak: {peakCorrelation?.toFixed(3)}</p>
              <button
                onClick={save}
                className="mt-3 w-full rounded-md bg-green-600 px-4 py-2 font-medium text-white"
              >
                Save Labeled Sample
              </button>
            </div>
          )}
        </>
      )}

      <section className="rounded-md border border-neutral-200 p-3 text-sm">
        <p className="font-medium">Collected samples: {total}</p>
        <ul className="mt-1 grid grid-cols-2 gap-x-4 text-neutral-600">
          {OBSTACLE_LABELS.map((l) => (
            <li key={l} className="flex justify-between capitalize">
              <span>{l}</span>
              <span>{counts[l] ?? 0}</span>
            </li>
          ))}
        </ul>
        <Link href="/dataset" className="mt-3 inline-block text-blue-600 underline">
          View & export dataset →
        </Link>
      </section>
    </main>
  );
}
