"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { generateChirp, crossCorrelate, findPeakIndex, delaySamplesToDistanceM, extractFeatures } from "@/lib/chirp";
import { emitAndCapture, getMicStream } from "@/lib/echoEngine";
import { loadModel, loadLabels, classify } from "@/lib/model";
import { AdaptiveController, signalRatio, type AdaptiveState } from "@/lib/adaptiveController";
import { type EchoSenseLedDevice, type PulseUpdate, bluetoothSupported, getSharedLedDevice } from "@/lib/ble";
import { fireSos } from "@/lib/sosService";
import { PredictionSmoother, type SmoothedPrediction } from "@/lib/predictionSmoother";
import { getCameraStream, captureFrame } from "@/lib/camera";
import { describeScene, VisionRequestError, type VisionResult } from "@/lib/vision";
import { describeSceneOffline } from "@/lib/offlineVlm";
import { speak, resetSpeechDedup, ttsSupported } from "@/lib/tts";
import { askAboutScene } from "@/lib/ask";
import { getSpeechRecognitionCtor, type SpeechRecognitionLike } from "@/lib/speechRecognition";
import TestRunLogger from "@/components/TestRunLogger";
import SosControl from "@/components/SosControl";
import EmergencyContactSettings from "@/components/EmergencyContactSettings";
import OfflineVlmSettings from "@/components/OfflineVlmSettings";

const VISION_INTERVAL_MS = 2500;
const VISION_OFFLINE_VLM_INTERVAL_MS = 3000; // offline captioning is a heavier generation step, similar cadence to cloud
const VISION_ERROR_BACKOFF_MS = 6000;
const VISION_STOP_HOLD_MS = 3500; // keeps LED override active until the next vision cycle lands
const VISION_REMIND_MS = 8000; // re-speak an unchanged scene at most this often, like a live guide checking in
const VISION_TRIP_THRESHOLD = 3; // consecutive failures before the circuit breaker opens
const VISION_COOLDOWN_MS = 30000; // how long to stay paused before trying again (quota/outage protection)
const STAIRS_CONFIDENCE_THRESHOLD = 0.8; // stairs skips the distance check entirely, so it needs a much higher bar than other labels to avoid false-alarm nagging
// Cloud vision is a real VLM and can describe stairs/walls/curbs itself, so
// sonar stays fully non-verbal when it's running. The offline captioner
// never does (see lib/offlineVlm.ts — it deliberately never reports a
// hazard), so with that toggle on there is otherwise no spoken hazard
// warning at all. Stairs is the one sonar-only exception, gated to offline
// mode specifically — see runCycle.
const STAIRS_ALERT_COOLDOWN_MS = 8000;

type Status = "idle" | "loading" | "ready" | "running" | "error";
type HazardLevel = "none" | "caution" | "stop";

const HAZARD_SEVERITY: Record<HazardLevel, number> = { none: 0, caution: 1, stop: 2 };

/** Combined severity — always yields the more urgent of the two readings. */
function worseHazard(a: HazardLevel, b: HazardLevel): HazardLevel {
  return HAZARD_SEVERITY[a] >= HAZARD_SEVERITY[b] ? a : b;
}

/**
 * Sonar's own hazard read, independent of vision. Stairs skip the distance
 * check entirely (fall risk regardless of measured distance) so a
 * misclassification there is costlier than any other label — it needs a much
 * higher confidence bar than the generic 0.5 threshold to avoid false-alarm
 * nagging from a borderline read. Everything else scales with proximity.
 */
function sonarHazardLevel(label: string, confidence: number, distanceM: number): HazardLevel {
  if (label === "none" || confidence <= 0.5) return "none";
  if (label === "stairs") return confidence > STAIRS_CONFIDENCE_THRESHOLD ? "stop" : "caution";
  if (distanceM < 0.5) return "stop";
  if (distanceM < 1.2) return "caution";
  return "none";
}

function stairsAlertMessage(distanceM: number): string {
  const cm = Math.round(distanceM * 100);
  return `Careful — stairs detected, about ${cm} centimeters ahead.`;
}

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
  const [sonarHazard, setSonarHazard] = useState<HazardLevel>("none");
  const [adaptiveState, setAdaptiveState] = useState<AdaptiveState>({ gain: 0.85, intervalMs: 350 });
  const [ledConnected, setLedConnected] = useState(false);
  const [ledError, setLedError] = useState<string | null>(null);
  const [pulseBpm, setPulseBpm] = useState<number | null>(null);
  const [visionResult, setVisionResult] = useState<VisionResult | null>(null);
  const [visionError, setVisionError] = useState<string | null>(null);
  const [visionPaused, setVisionPaused] = useState(false);
  const [askStatus, setAskStatus] = useState<"idle" | "listening" | "thinking" | "error">("idle");
  const [askAnswer, setAskAnswer] = useState<string | null>(null);
  const [useOfflineVlm, setUseOfflineVlm] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const visionRunningRef = useRef(false);
  const visionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visionErrorStreakRef = useRef(0);
  const useOfflineVlmRef = useRef(false);
  const stairsAlertCooldownRef = useRef(0);
  const visionStopUntilRef = useRef(0);
  const lastSpokenKeyRef = useRef<string>("");
  const lastSpokenAtRef = useRef(0);
  const sosActiveRef = useRef(false);
  const ledDeviceRef = useRef<EchoSenseLedDevice | null>(null);
  const pulseUnsubscribeRef = useRef<(() => void) | null>(null);
  const lastPulseSosActiveRef = useRef(false);
  const modelRef = useRef<Awaited<ReturnType<typeof loadModel>> | null>(null);
  const labelsRef = useRef<string[]>([]);
  const controllerRef = useRef(new AdaptiveController());
  const smootherRef = useRef(new PredictionSmoother());
  const runningRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const askingRef = useRef(false);
  const askRecognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    useOfflineVlmRef.current = useOfflineVlm;
  }, [useOfflineVlm]);

  const runCycle = useCallback(async () => {
    if (!runningRef.current || !streamRef.current || !modelRef.current) return;
    if (askingRef.current) {
      // Pause chirp emission while the user is asking a question — avoids the
      // chirp sound and mic contention interfering with speech recognition.
      // Resumes automatically once askingRef clears.
      timeoutRef.current = setTimeout(runCycle, 300);
      return;
    }
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

      const hazard = sonarHazardLevel(pred.label, pred.confidence, dist);
      setSonarHazard(hazard);
      // Sonar stays non-verbal (vibration + LEDs only) whenever cloud vision
      // is running — it's a real VLM and covers stairs/walls/curbs itself.
      // The offline captioner never reports a hazard at all (see
      // lib/offlineVlm.ts), so with that toggle on, stairs keeps a narrow
      // spoken exception — otherwise a real fall hazard would have no voice.
      if (
        useOfflineVlmRef.current &&
        pred.label === "stairs" &&
        pred.confidence > STAIRS_CONFIDENCE_THRESHOLD &&
        !sosActiveRef.current
      ) {
        const now = Date.now();
        if (now - stairsAlertCooldownRef.current > STAIRS_ALERT_COOLDOWN_MS) {
          stairsAlertCooldownRef.current = now;
          speak(stairsAlertMessage(dist), "urgent");
        }
      }

      // SOS owns the LEDs while active — don't let the sonar loop overwrite them.
      if (ledDeviceRef.current?.connected && !sosActiveRef.current) {
        const visionStopActive = Date.now() < visionStopUntilRef.current;
        const fusedStop = visionStopActive || hazard === "stop";
        ledDeviceRef.current.send(
          fusedStop ? "hard-stop" : pred.confidence > 0.5 ? pred.label : "none",
          dist,
        );
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

  const runVisionCycle = useCallback(async () => {
    if (!visionRunningRef.current || !videoRef.current) return;
    try {
      const isOffline = useOfflineVlmRef.current;
      let result: VisionResult;
      if (isOffline) {
        result = await describeSceneOffline(videoRef.current);
      } else {
        const frame = captureFrame(videoRef.current);
        if (!frame) {
          setVisionError("Camera feed not ready yet…");
          return;
        }
        result = await describeScene(frame);
      }
      visionErrorStreakRef.current = 0;
      setVisionResult(result);
      setVisionError(null);

      const isStop = result.hazard_level === "stop";
      // The offline captioner never sets hazard_level above "none" (see
      // lib/offlineVlm.ts) — its "none" still means "here's a caption," so it
      // keys off the caption text itself. Cloud vision's "none" is a real,
      // deliberate "path is clear" read from an actual VLM, unlike the old
      // on-device object detector's "none" (which just meant "no COCO object
      // found") — so both sources always have something worth speaking.
      const key = isOffline ? `offline:${result.message}` : `${result.direction}:${result.hazard_level}`;

      const changed = key !== lastSpokenKeyRef.current;
      const dueForReminder = Date.now() - lastSpokenAtRef.current > VISION_REMIND_MS;
      // Suppressed during SOS so routine narration doesn't talk over the siren/emergency
      // flow; also suppressed (except genuine hazards) while the user is mid-question so
      // routine chatter doesn't step on their answer.
      const canSpeak = !sosActiveRef.current && (!askingRef.current || isStop);
      if (canSpeak && (changed || dueForReminder || isStop)) {
        speak(result.message, isStop ? "urgent" : "normal");
        lastSpokenKeyRef.current = key;
        lastSpokenAtRef.current = Date.now();
      }
      if (result.hazard_level === "stop" && !sosActiveRef.current) {
        visionStopUntilRef.current = Date.now() + VISION_STOP_HOLD_MS;
        if ("vibrate" in navigator) navigator.vibrate([200, 100, 200, 100, 200]);
      }
    } catch (e) {
      visionErrorStreakRef.current += 1;
      const rateLimited = e instanceof VisionRequestError && e.status === 429;
      setVisionError(
        rateLimited
          ? "Vision model rate-limited — sonar navigation keeps running."
          : e instanceof Error
            ? e.message
            : "Vision cycle failed",
      );

      // Circuit breaker: after repeated failures (rate limit or otherwise),
      // stop hammering the API and go quiet for a cooldown instead of erroring
      // every cycle — sonar + LEDs are unaffected and keep working the whole time.
      if (visionErrorStreakRef.current >= VISION_TRIP_THRESHOLD) {
        setVisionPaused(true);
        if (visionRunningRef.current) {
          visionTimeoutRef.current = setTimeout(() => {
            visionErrorStreakRef.current = 0;
            setVisionPaused(false);
            runVisionCycle();
          }, VISION_COOLDOWN_MS);
        }
        return;
      }
    } finally {
      if (visionRunningRef.current && visionErrorStreakRef.current < VISION_TRIP_THRESHOLD) {
        const baseInterval = useOfflineVlmRef.current ? VISION_OFFLINE_VLM_INTERVAL_MS : VISION_INTERVAL_MS;
        const delay = visionErrorStreakRef.current > 0 ? VISION_ERROR_BACKOFF_MS : baseInterval;
        visionTimeoutRef.current = setTimeout(runVisionCycle, delay);
      }
    }
  }, []);

  // Push-to-talk: "what's on the table", "read this sign", "is anyone near
  // me" — an on-demand answer about the current frame, on top of the passive
  // continuous narration. Runs on /infer specifically (unlike the /gesture
  // shout-"help" trigger) even though the mic is already busy with sonar —
  // runCycle pauses chirp emission via askingRef while this is active, so
  // the two don't fight over the microphone.
  const startAsk = () => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setAskStatus("error");
      setAskAnswer("Voice questions need Chrome or Safari — not supported in this browser.");
      return;
    }
    askingRef.current = true;
    setAskStatus("listening");
    setAskAnswer(null);

    const recognition = new Ctor();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.onresult = async (e) => {
      const question = e.results[0]?.[0]?.transcript;
      if (!question) return;
      setAskStatus("thinking");
      try {
        const frame = videoRef.current ? captureFrame(videoRef.current) : null;
        if (!frame) throw new Error("Camera not ready");
        const answer = await askAboutScene(frame, question);
        setAskAnswer(answer);
        speak(answer, "urgent");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Couldn't get an answer";
        setAskAnswer(message);
        speak("Sorry, I couldn't answer that.", "urgent");
      } finally {
        askingRef.current = false;
        setAskStatus("idle");
      }
    };
    recognition.onerror = (e) => {
      askingRef.current = false;
      if (e.error === "no-speech" || e.error === "aborted") {
        setAskStatus("idle");
        return;
      }
      setAskStatus("error");
      setAskAnswer(e.error === "not-allowed" ? "Microphone permission denied." : "Didn't catch that — try again.");
    };
    recognition.onend = () => {
      askingRef.current = false;
      // If onresult never fired (nothing recognized), fall back to idle rather than sticking on "listening".
      setAskStatus((s) => (s === "listening" ? "idle" : s));
    };
    askRecognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      askingRef.current = false;
      setAskStatus("idle");
    }
  };

  const stopAsk = () => {
    askRecognitionRef.current?.stop();
  };

  const reconnectMic = useCallback(async () => {
    if (!runningRef.current) return;
    try {
      streamRef.current = await getMicStream();
      streamRef.current.getTracks().forEach((t) => t.addEventListener("ended", reconnectMic, { once: true }));
    } catch {
      // Device likely still unavailable (e.g. permission revoked); the next
      // sonar cycle's own failure path will surface an error to the user.
    }
  }, []);

  const reconnectCamera = useCallback(async () => {
    if (!visionRunningRef.current) return;
    try {
      cameraStreamRef.current = await getCameraStream();
      cameraStreamRef.current.getTracks().forEach((t) => t.addEventListener("ended", reconnectCamera, { once: true }));
      if (videoRef.current) {
        videoRef.current.srcObject = cameraStreamRef.current;
        await videoRef.current.play();
      }
      setVisionError(null);
    } catch (e) {
      setVisionError(e instanceof Error ? e.message : "Camera disconnected");
    }
  }, []);

  const start = async () => {
    setError(null);
    setStatus("loading");
    try {
      if (!streamRef.current) {
        streamRef.current = await getMicStream();
        streamRef.current.getTracks().forEach((t) => t.addEventListener("ended", reconnectMic, { once: true }));
      }
      if (!modelRef.current) {
        modelRef.current = await loadModel();
        labelsRef.current = await loadLabels();
      }
      smootherRef.current.reset();
      stairsAlertCooldownRef.current = 0;
      setSonarHazard("none");
      setStatus("running");
      runningRef.current = true;
      runCycle();

      try {
        if (!cameraStreamRef.current) {
          cameraStreamRef.current = await getCameraStream();
          cameraStreamRef.current.getTracks().forEach((t) => t.addEventListener("ended", reconnectCamera, { once: true }));
        }
        if (videoRef.current) {
          videoRef.current.srcObject = cameraStreamRef.current;
          await videoRef.current.play();
        }
        setVisionError(null);
        setVisionPaused(false);
        visionErrorStreakRef.current = 0;
        resetSpeechDedup();
        lastSpokenKeyRef.current = "";
        lastSpokenAtRef.current = 0;
        visionRunningRef.current = true;
        runVisionCycle();
      } catch (e) {
        setVisionError(e instanceof Error ? e.message : "Camera unavailable");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start");
      setStatus("error");
    }
  };

  const stop = () => {
    runningRef.current = false;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    visionRunningRef.current = false;
    if (visionTimeoutRef.current) clearTimeout(visionTimeoutRef.current);
    askingRef.current = false;
    askRecognitionRef.current?.stop();
    setAskStatus("idle");
    setStatus("ready");
  };

  const connectLed = async () => {
    setLedError(null);
    try {
      if (!ledDeviceRef.current) ledDeviceRef.current = getSharedLedDevice();
      await ledDeviceRef.current.connect();
      setLedConnected(true);

      lastPulseSosActiveRef.current = false;
      pulseUnsubscribeRef.current = ledDeviceRef.current.onPulseUpdate((update: PulseUpdate) => {
        setPulseBpm(update.bpm);
        // Rising edge only — fireSos() no-ops if already active anyway, but
        // this avoids the check running on every ~500ms notification.
        if (update.sosActive && !lastPulseSosActiveRef.current) {
          fireSos();
        }
        lastPulseSosActiveRef.current = update.sosActive;
      });
    } catch (e) {
      setLedError(e instanceof Error ? e.message : "Failed to connect to ESP32");
    }
  };

  const disconnectLed = () => {
    pulseUnsubscribeRef.current?.();
    pulseUnsubscribeRef.current = null;
    setPulseBpm(null);
    ledDeviceRef.current?.disconnect();
    setLedConnected(false);
  };

  useEffect(() => {
    return () => {
      runningRef.current = false;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      visionRunningRef.current = false;
      if (visionTimeoutRef.current) clearTimeout(visionTimeoutRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
      pulseUnsubscribeRef.current?.();
      ledDeviceRef.current?.disconnect();
      askingRef.current = false;
      askRecognitionRef.current?.stop();
    };
  }, []);

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6 pb-24">
      <header>
        <h1 className="text-2xl font-semibold">EchoSense — Live</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Sonar (1D CNN) + camera vision (Llama 3.2 Vision via NVIDIA NIM) fused into one hazard verdict — driving
          vibration, spoken guidance, and the ESP32 LEDs together, running continuously. An offline on-device model
          is available below as an alternative narration source.
        </p>
        <Link
          href="/"
          className="mt-2 inline-flex items-center gap-1 rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-100"
        >
          <span aria-hidden="true">←</span> Back
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

      {status === "running" && (() => {
        const combinedHazard = worseHazard(sonarHazard, visionResult?.hazard_level ?? "none");
        const style =
          combinedHazard === "stop"
            ? "border-red-400 bg-red-50 text-red-700"
            : combinedHazard === "caution"
              ? "border-amber-400 bg-amber-50 text-amber-700"
              : "border-green-400 bg-green-50 text-green-700";
        return (
          <section className={`rounded-md border p-4 ${style}`}>
            <p className="text-xs uppercase tracking-wide opacity-70">Fused verdict (sonar + vision)</p>
            <p className="text-3xl font-bold uppercase">{combinedHazard}</p>
            <p className="mt-1 text-xs opacity-80">
              Sonar: {prediction ? `${prediction.label} (${sonarHazard})` : "warming up…"} · Vision:{" "}
              {visionResult ? visionResult.hazard_level : "warming up…"}
            </p>
          </section>
        );
      })()}

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

      <section className="rounded-md border border-neutral-300 p-4">
        <p className="text-xs uppercase tracking-wide text-neutral-500">Vision (camera)</p>
        <div className="relative mt-2 overflow-hidden rounded-md bg-black">
          <video ref={videoRef} autoPlay muted playsInline className="h-56 w-full object-cover" />

          {status === "running" && (
            <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/60 px-2 py-1">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
              <span className="text-[10px] font-semibold uppercase tracking-wide text-white">Live</span>
            </div>
          )}

          {visionResult && (
            <span
              className={`absolute right-2 top-2 rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-white ${
                visionResult.hazard_level === "stop"
                  ? "bg-red-600"
                  : visionResult.hazard_level === "caution"
                    ? "bg-amber-500"
                    : "bg-green-600"
              }`}
            >
              {visionResult.direction}
            </span>
          )}

          {visionResult && (
            <div
              className={`absolute inset-x-0 bottom-0 px-3 py-2 text-sm font-medium text-white backdrop-blur-sm ${
                visionResult.hazard_level === "stop"
                  ? "bg-red-600/80"
                  : visionResult.hazard_level === "caution"
                    ? "bg-amber-600/80"
                    : "bg-black/70"
              }`}
            >
              {visionResult.message}
            </div>
          )}
        </div>

        {visionPaused && (
          <p className="mt-2 text-xs text-amber-600">
            Vision paused (repeated failures / rate limit) — retrying automatically. Sonar navigation and vibration
            keep working normally.
          </p>
        )}
        {!visionPaused && visionError && <p className="mt-2 text-xs text-red-600">{visionError}</p>}
        {visionResult && (
          <p className="mt-2 text-xs text-neutral-500 capitalize">
            {visionResult.scene} · move {visionResult.direction}
          </p>
        )}
        {!ttsSupported() && (
          <p className="mt-2 text-xs text-neutral-400">Speech output needs a browser with Web Speech API support.</p>
        )}

        {status === "running" && (
          <div className="mt-3">
            <button
              onPointerDown={startAsk}
              onPointerUp={stopAsk}
              onPointerLeave={stopAsk}
              onPointerCancel={stopAsk}
              disabled={askStatus === "thinking"}
              className={`w-full rounded-md px-4 py-3 text-sm font-semibold text-white transition-colors disabled:opacity-60 ${
                askStatus === "listening" ? "animate-pulse bg-blue-700" : "bg-blue-600"
              }`}
            >
              {askStatus === "listening"
                ? "🎤 Listening…"
                : askStatus === "thinking"
                  ? "Thinking…"
                  : "🎤 Hold to Ask a Question"}
            </button>
            <p className="mt-1 text-center text-xs text-neutral-400">
              e.g. &quot;what&apos;s on the table&quot;, &quot;read this sign&quot;, &quot;is anyone near me&quot;
            </p>
            {askAnswer && <p className="mt-2 rounded-md bg-blue-50 p-2 text-sm text-blue-900">{askAnswer}</p>}
          </div>
        )}
      </section>

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
            <div className="mt-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-green-700">● Connected</span>
                <button onClick={disconnectLed} className="text-xs text-red-600 underline">
                  Disconnect
                </button>
              </div>
              <p className="mt-1 text-xs text-neutral-500">
                Pulse: {pulseBpm !== null && pulseBpm > 0 ? `${pulseBpm} BPM` : "no reading (board's pulse sensor not found, or no finger on it)"}
                {" · SOS auto-triggers at 120+ BPM sustained"}
              </p>
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

      <TestRunLogger />

      <OfflineVlmSettings enabled={useOfflineVlm} onEnabledChange={setUseOfflineVlm} />

      <EmergencyContactSettings />

      <SosControl sosActiveRef={sosActiveRef} />
    </main>
  );
}
