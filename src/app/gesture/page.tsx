"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { loadHandLandmarker, getCameraStream } from "@/lib/handTracker";
import { classifyGesture, GESTURE_SPEECH, type GestureLabel } from "@/lib/gestureRules";
import { loadAlphabetModel, loadAlphabetLabels, classifyLetter } from "@/lib/gestureAlphabetModel";

type Status = "idle" | "loading" | "ready" | "running" | "error";
type Mode = "word" | "letter";

const CONFIRM_FRAMES = 8;
const LETTER_CONFIDENCE_THRESHOLD = 0.6;

const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

function speak(text: string) {
  if (!("speechSynthesis" in window) || !text) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.95;
  window.speechSynthesis.speak(utterance);
}

/** Crops the hand region (from landmark bounding box) into a 28x28 true-grayscale canvas. */
function cropHandToGrayscale28(
  video: HTMLVideoElement,
  landmarks: { x: number; y: number }[],
  scratchCanvas: HTMLCanvasElement,
  outCanvas: HTMLCanvasElement
): boolean {
  const xs = landmarks.map((l) => l.x * video.videoWidth);
  const ys = landmarks.map((l) => l.y * video.videoHeight);
  const pad = 40;
  const minX = Math.max(0, Math.min(...xs) - pad);
  const minY = Math.max(0, Math.min(...ys) - pad);
  const maxX = Math.min(video.videoWidth, Math.max(...xs) + pad);
  const maxY = Math.min(video.videoHeight, Math.max(...ys) + pad);
  const w = maxX - minX;
  const h = maxY - minY;
  if (w <= 0 || h <= 0) return false;

  const scratchCtx = scratchCanvas.getContext("2d");
  const outCtx = outCanvas.getContext("2d");
  if (!scratchCtx || !outCtx) return false;

  // Square crop (Sign Language MNIST images are square) padded from the tighter bbox dimension.
  const side = Math.max(w, h);
  const cx = minX + w / 2;
  const cy = minY + h / 2;
  const sx = Math.max(0, cx - side / 2);
  const sy = Math.max(0, cy - side / 2);

  scratchCanvas.width = side;
  scratchCanvas.height = side;
  scratchCtx.drawImage(video, sx, sy, side, side, 0, 0, side, side);

  outCanvas.width = 28;
  outCanvas.height = 28;
  outCtx.drawImage(scratchCanvas, 0, 0, 28, 28);

  const imageData = outCtx.getImageData(0, 0, 28, 28);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = gray;
  }
  outCtx.putImageData(imageData, 0, 0);
  return true;
}

export default function GesturePage() {
  const [status, setStatus] = useState<Status>("idle");
  const [mode, setMode] = useState<Mode>("word");
  const [error, setError] = useState<string | null>(null);
  const [currentGesture, setCurrentGesture] = useState<GestureLabel>("none");
  const [currentLetter, setCurrentLetter] = useState<string | null>(null);
  const [buffer, setBuffer] = useState("");
  const [history, setHistory] = useState<string[]>([]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scratchCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cropCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const landmarkerRef = useRef<Awaited<ReturnType<typeof loadHandLandmarker>> | null>(null);
  const alphabetModelRef = useRef<Awaited<ReturnType<typeof loadAlphabetModel>> | null>(null);
  const alphabetLabelsRef = useRef<string[]>([]);
  const runningRef = useRef(false);
  const modeRef = useRef<Mode>("word");
  const rafRef = useRef<number | null>(null);

  const stableLabelRef = useRef<GestureLabel>("none");
  const streakRef = useRef(0);
  const spokenForCurrentHoldRef = useRef(false);

  const stableLetterRef = useRef<string | null>(null);
  const letterStreakRef = useRef(0);
  const appendedForCurrentHoldRef = useRef(false);

  useEffect(() => {
    modeRef.current = mode;
    stableLabelRef.current = "none";
    streakRef.current = 0;
    stableLetterRef.current = null;
    letterStreakRef.current = 0;
    setCurrentGesture("none");
    setCurrentLetter(null);
  }, [mode]);

  const drawFrame = useCallback((landmarks: { x: number; y: number }[] | null) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!landmarks) return;

    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 3;
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.beginPath();
      ctx.moveTo(landmarks[a].x * canvas.width, landmarks[a].y * canvas.height);
      ctx.lineTo(landmarks[b].x * canvas.width, landmarks[b].y * canvas.height);
      ctx.stroke();
    }
    ctx.fillStyle = "#16a34a";
    for (const lm of landmarks) {
      ctx.beginPath();
      ctx.arc(lm.x * canvas.width, lm.y * canvas.height, 4, 0, 2 * Math.PI);
      ctx.fill();
    }
  }, []);

  const runWordMode = useCallback((landmarks: { x: number; y: number; z: number }[] | null) => {
    const label = landmarks ? classifyGesture(landmarks) : "none";
    if (label === stableLabelRef.current) {
      streakRef.current += 1;
    } else {
      stableLabelRef.current = label;
      streakRef.current = 1;
      spokenForCurrentHoldRef.current = false;
    }
    if (streakRef.current >= CONFIRM_FRAMES) {
      setCurrentGesture(label);
      if (label !== "none" && !spokenForCurrentHoldRef.current) {
        const phrase = GESTURE_SPEECH[label];
        speak(phrase);
        setHistory((h) => [phrase, ...h].slice(0, 10));
        spokenForCurrentHoldRef.current = true;
      }
    }
  }, []);

  const runLetterMode = useCallback(
    async (landmarks: { x: number; y: number; z: number }[] | null) => {
      if (!landmarks || !videoRef.current || !alphabetModelRef.current) {
        stableLetterRef.current = null;
        letterStreakRef.current = 0;
        setCurrentLetter(null);
        return;
      }
      if (!scratchCanvasRef.current) scratchCanvasRef.current = document.createElement("canvas");
      if (!cropCanvasRef.current) cropCanvasRef.current = document.createElement("canvas");

      const ok = cropHandToGrayscale28(videoRef.current, landmarks, scratchCanvasRef.current, cropCanvasRef.current);
      if (!ok) return;

      const pred = await classifyLetter(alphabetModelRef.current, alphabetLabelsRef.current, cropCanvasRef.current);
      const label = pred.confidence >= LETTER_CONFIDENCE_THRESHOLD ? pred.letter : null;

      if (label === stableLetterRef.current) {
        letterStreakRef.current += 1;
      } else {
        stableLetterRef.current = label;
        letterStreakRef.current = 1;
        appendedForCurrentHoldRef.current = false;
      }

      if (letterStreakRef.current >= CONFIRM_FRAMES) {
        setCurrentLetter(label);
        if (label && !appendedForCurrentHoldRef.current) {
          setBuffer((b) => b + label);
          appendedForCurrentHoldRef.current = true;
        }
      }
    },
    []
  );

  const loop = useCallback(() => {
    if (!runningRef.current || !videoRef.current || !landmarkerRef.current) return;
    const video = videoRef.current;
    if (video.readyState >= 2) {
      const result = landmarkerRef.current.detectForVideo(video, performance.now());
      const landmarks = result.landmarks?.[0] ?? null;
      drawFrame(landmarks);

      if (modeRef.current === "word") {
        runWordMode(landmarks);
      } else {
        runLetterMode(landmarks);
      }
    }
    rafRef.current = requestAnimationFrame(loop);
  }, [drawFrame, runWordMode, runLetterMode]);

  const start = async () => {
    setError(null);
    setStatus("loading");
    try {
      if (!streamRef.current) streamRef.current = await getCameraStream();
      if (videoRef.current) {
        videoRef.current.srcObject = streamRef.current;
        await videoRef.current.play();
      }
      if (!landmarkerRef.current) landmarkerRef.current = await loadHandLandmarker();
      if (!alphabetModelRef.current) {
        alphabetModelRef.current = await loadAlphabetModel();
        alphabetLabelsRef.current = await loadAlphabetLabels();
      }
      setStatus("running");
      runningRef.current = true;
      rafRef.current = requestAnimationFrame(loop);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start");
      setStatus("error");
    }
  };

  const stop = () => {
    runningRef.current = false;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setStatus("ready");
  };

  const speakBuffer = () => {
    if (!buffer) return;
    speak(buffer);
    setHistory((h) => [buffer, ...h].slice(0, 10));
  };

  useEffect(() => {
    return () => {
      runningRef.current = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">GestureTalk — Live</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Sense (camera) → Infer (MediaPipe + {mode === "word" ? "gesture rules" : "CNN"}) → Act (speech).
        </p>
        <Link href="/" className="mt-1 inline-block text-sm text-blue-600 underline">
          ← Back
        </Link>
      </header>

      {error && (
        <div className="rounded-md border border-red-400 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => setMode("word")}
          className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium ${
            mode === "word" ? "border-black bg-black text-white" : "border-neutral-300"
          }`}
        >
          Common Words
        </button>
        <button
          onClick={() => setMode("letter")}
          className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium ${
            mode === "letter" ? "border-black bg-black text-white" : "border-neutral-300"
          }`}
        >
          Fingerspelling (A-Z)
        </button>
      </div>

      <div className="relative w-full overflow-hidden rounded-md bg-black">
        <video ref={videoRef} className="w-full -scale-x-100" playsInline muted />
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full -scale-x-100" />
      </div>

      <div className="flex gap-3">
        {status !== "running" ? (
          <button
            onClick={start}
            disabled={status === "loading"}
            className="flex-1 rounded-md bg-black px-4 py-3 font-medium text-white disabled:opacity-50"
          >
            {status === "loading" ? "Loading models…" : "Start"}
          </button>
        ) : (
          <button onClick={stop} className="flex-1 rounded-md bg-red-600 px-4 py-3 font-medium text-white">
            Stop
          </button>
        )}
      </div>

      {mode === "word" ? (
        <section className="rounded-md border border-neutral-300 p-4 text-center">
          <p className="text-xs uppercase tracking-wide text-neutral-500">Detected sign</p>
          <p className="text-3xl font-bold capitalize">
            {currentGesture === "none" ? "—" : GESTURE_SPEECH[currentGesture]}
          </p>
        </section>
      ) : (
        <section className="rounded-md border border-neutral-300 p-4">
          <p className="text-xs uppercase tracking-wide text-neutral-500">Detected letter</p>
          <p className="text-3xl font-bold">{currentLetter ?? "—"}</p>
          <p className="mt-3 min-h-8 rounded bg-neutral-100 px-3 py-2 text-lg tracking-wide">{buffer || " "}</p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={speakBuffer}
              disabled={!buffer}
              className="flex-1 rounded-md bg-green-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              Speak
            </button>
            <button
              onClick={() => setBuffer((b) => b + " ")}
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
            >
              Space
            </button>
            <button
              onClick={() => setBuffer((b) => b.slice(0, -1))}
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm"
            >
              ⌫
            </button>
            <button
              onClick={() => setBuffer("")}
              className="rounded-md border border-red-300 px-3 py-2 text-sm text-red-600"
            >
              Clear
            </button>
          </div>
        </section>
      )}

      {history.length > 0 && (
        <section className="rounded-md border border-neutral-200 p-3 text-sm">
          <p className="mb-2 font-medium text-neutral-700">Spoken</p>
          <ul className="flex flex-col gap-1 text-neutral-600">
            {history.map((phrase, i) => (
              <li key={i}>{phrase}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-md border border-neutral-200 p-3 text-xs text-neutral-500">
        <p className="font-medium text-neutral-700">Phase 1 scope</p>
        <p>
          Common Words: Hello (open palm) · Yes (fist) · No (index+middle) · I Love You (ILY handshape) —
          static single-hand signs only.
        </p>
        <p className="mt-1">
          Fingerspelling: A-Z static handshapes (excludes J, Z — those require motion), CNN trained on real
          public ASL image data.
        </p>
      </section>
    </main>
  );
}
