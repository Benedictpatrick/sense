"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { generateChirp, crossCorrelate, findPeakIndex, delaySamplesToDistanceM, extractFeatures } from "@/lib/chirp";
import { emitAndCapture, getMicStream } from "@/lib/echoEngine";
import { loadModel, loadLabels, classify } from "@/lib/model";
import { AdaptiveController, signalRatio, type AdaptiveState } from "@/lib/adaptiveController";
import { EchoSenseLedDevice, bluetoothSupported } from "@/lib/ble";
import { PredictionSmoother, type SmoothedPrediction } from "@/lib/predictionSmoother";

type Status = "idle" | "loading" | "ready" | "running" | "error";

function vibrationPattern(label: string, distanceM: number): number[] {
  const proximity = Math.max(0, Math.min(1, 1 - distanceM / 3)); // 1 = very close, 0 = far
  const pulse = Math.round(40 + proximity * 140);
  switch (label) {
    case "wall":
      return [pulse];
    case "person":
      return [pulse, 60, pulse];
    case "stairs":
      return [60, 40, 60, 40, 60];
    case "doorway":
      return proximity > 0.6 ? [30] : [];
    default:
      return [];
  }
}

export default function InferPage() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [prediction, setPrediction] = useState<SmoothedPrediction | null>(null);
  const [distanceM, setDistanceM] = useState<number | null>(null);
  const [adaptiveState, setAdaptiveState] = useState<AdaptiveState>({ gain: 0.85, intervalMs: 350 });
  const [ledConnected, setLedConnected] = useState(false);
  const [ledError, setLedError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const ledDeviceRef = useRef<EchoSenseLedDevice | null>(null);
  const modelRef = useRef<Awaited<ReturnType<typeof loadModel>> | null>(null);
  const labelsRef = useRef<string[]>([]);
  const controllerRef = useRef(new AdaptiveController());
  const smootherRef = useRef(new PredictionSmoother());
  const runningRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runCycle = useCallback(async () => {
    if (!runningRef.current || !streamRef.current || !modelRef.current) return;
    try {
      const gain = controllerRef.current.state.gain;
      const result = await emitAndCapture(streamRef.current, gain);
      const chirp = generateChirp(result.sampleRate);

      const feat = extractFeatures(result.waveform, chirp, result.chirpStartSample, result.sampleRate);
      const raw = await classify(modelRef.current, labelsRef.current, feat);
      const pred = smootherRef.current.update(raw.probabilities);
      setPrediction(pred);

      const corr = crossCorrelate(result.waveform, chirp);
      const guard = Math.round(0.003 * result.sampleRate);
      const skip = result.chirpStartSample + chirp.length + guard;
      const peakIdx = findPeakIndex(corr, skip);
      const delaySamples = peakIdx - result.chirpStartSample;
      const dist = delaySamplesToDistanceM(Math.max(delaySamples, 0), result.sampleRate);
      setDistanceM(dist);

      if (pred.label !== "none" && pred.confidence > 0.5) {
        const pattern = vibrationPattern(pred.label, dist);
        if (pattern.length > 0 && "vibrate" in navigator) navigator.vibrate(pattern);
      }
      if (ledDeviceRef.current?.connected) {
        ledDeviceRef.current.send(pred.confidence > 0.5 ? pred.label : "none", dist);
      }

      const ratio = signalRatio(feat);
      const next = controllerRef.current.update(ratio);
      setAdaptiveState(next);

      if (runningRef.current) {
        timeoutRef.current = setTimeout(runCycle, next.intervalMs);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Inference cycle failed");
      runningRef.current = false;
      setStatus("error");
    }
  }, []);

  const start = async () => {
    setError(null);
    setStatus("loading");
    try {
      if (!streamRef.current) streamRef.current = await getMicStream();
      if (!modelRef.current) {
        modelRef.current = await loadModel();
        labelsRef.current = await loadLabels();
      }
      smootherRef.current.reset();
      setStatus("running");
      runningRef.current = true;
      runCycle();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start");
      setStatus("error");
    }
  };

  const stop = () => {
    runningRef.current = false;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setStatus("ready");
  };

  const connectLed = async () => {
    setLedError(null);
    try {
      if (!ledDeviceRef.current) ledDeviceRef.current = new EchoSenseLedDevice();
      await ledDeviceRef.current.connect();
      setLedConnected(true);
    } catch (e) {
      setLedError(e instanceof Error ? e.message : "Failed to connect to ESP32");
    }
  };

  const disconnectLed = () => {
    ledDeviceRef.current?.disconnect();
    setLedConnected(false);
  };

  useEffect(() => {
    return () => {
      runningRef.current = false;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      ledDeviceRef.current?.disconnect();
    };
  }, []);

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">EchoSense — Live</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Sense → Infer (1D CNN) → Act (vibration) → Adapt (gain/polling rate), running continuously.
        </p>
        <Link href="/" className="mt-1 inline-block text-sm text-blue-600 underline">
          ← Back
        </Link>
      </header>

      {error && (
        <div className="rounded-md border border-red-400 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      <div className="flex gap-3">
        {status !== "running" ? (
          <button
            onClick={start}
            disabled={status === "loading"}
            className="flex-1 rounded-md bg-black px-4 py-3 font-medium text-white disabled:opacity-50"
          >
            {status === "loading" ? "Loading model…" : "Start"}
          </button>
        ) : (
          <button onClick={stop} className="flex-1 rounded-md bg-red-600 px-4 py-3 font-medium text-white">
            Stop
          </button>
        )}
      </div>

      {prediction && (
        <section className="rounded-md border border-neutral-300 p-4">
          <p className="text-xs uppercase tracking-wide text-neutral-500">Detected</p>
          <p className="text-3xl font-bold capitalize">{prediction.label}</p>
          <p className="text-sm text-neutral-500">
            confidence {(prediction.confidence * 100).toFixed(0)}% · est.{" "}
            {distanceM !== null ? (distanceM * 100).toFixed(0) : "—"} cm
          </p>
          <div className="mt-3 flex flex-col gap-1">
            {Object.entries(prediction.probabilities)
              .sort((a, b) => b[1] - a[1])
              .map(([label, p]) => (
                <div key={label} className="flex items-center gap-2 text-xs">
                  <span className="w-16 capitalize text-neutral-500">{label}</span>
                  <div className="h-2 flex-1 rounded-full bg-neutral-100">
                    <div
                      className="h-2 rounded-full bg-black"
                      style={{ width: `${Math.round(p * 100)}%` }}
                    />
                  </div>
                  <span className="w-10 text-right text-neutral-500">{Math.round(p * 100)}%</span>
                </div>
              ))}
          </div>
        </section>
      )}

      <section className="rounded-md border border-neutral-200 p-3 text-xs text-neutral-500">
        <p className="font-medium text-neutral-700">Adaptive control state</p>
        <p>chirp gain: {adaptiveState.gain.toFixed(2)}</p>
        <p>polling interval: {adaptiveState.intervalMs}ms</p>
      </section>

      {bluetoothSupported() ? (
        <section className="rounded-md border border-neutral-200 p-3 text-sm">
          <p className="font-medium text-neutral-700">ESP32 wearable (LEDs)</p>
          {ledError && <p className="mt-1 text-xs text-red-600">{ledError}</p>}
          {ledConnected ? (
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs text-green-700">● Connected</span>
              <button onClick={disconnectLed} className="text-xs text-red-600 underline">
                Disconnect
              </button>
            </div>
          ) : (
            <button
              onClick={connectLed}
              className="mt-2 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium"
            >
              Connect ESP32
            </button>
          )}
        </section>
      ) : (
        <p className="text-xs text-neutral-400">
          ESP32 LED output needs Web Bluetooth (supported in Chrome on Android).
        </p>
      )}
    </main>
  );
}
