import type { Detection } from "@mediapipe/tasks-vision";
import { loadObjectDetector } from "./objectDetector";
import type { VisionResult } from "./vision";

// A bounding box this fraction of the frame's area (or bigger) reads as
// "about to be hit" — tuned against a phone held chest-high at walking pace.
const STOP_AREA_FRACTION = 0.2;
const CAUTION_AREA_FRACTION = 0.06;
// A box whose bottom edge is this far down the frame is on the ground close
// to the camera even if it's visually small (e.g. a curb or a low object) —
// area alone under-counts objects near the bottom edge of the frame.
const STOP_BOTTOM_FRACTION = 0.92;
const CAUTION_BOTTOM_FRACTION = 0.75;

const GROUND_HAZARD_LABELS = new Set(["person", "chair", "bench", "suitcase", "backpack", "dog", "bicycle", "car"]);

function clockDirection(centerXFraction: number): "left" | "ahead" | "right" {
  if (centerXFraction < 0.35) return "left";
  if (centerXFraction > 0.65) return "right";
  return "ahead";
}

/**
 * Picks the single most urgent detection to narrate. A closer/bigger box
 * always wins over a further/smaller one, regardless of raw model
 * confidence — proximity is what matters for collision avoidance, not which
 * label the model was more sure about.
 */
function proximityScore(d: Detection, frameW: number, frameH: number): number {
  const box = d.boundingBox;
  if (!box) return 0;
  const areaFraction = (box.width * box.height) / (frameW * frameH);
  const bottomFraction = (box.originY + box.height) / frameH;
  return Math.max(areaFraction / STOP_AREA_FRACTION, (bottomFraction - 0.5) / (STOP_BOTTOM_FRACTION - 0.5));
}

function hazardFromDetection(d: Detection, frameW: number, frameH: number): VisionResult["hazard_level"] {
  const box = d.boundingBox;
  if (!box) return "none";
  const areaFraction = (box.width * box.height) / (frameW * frameH);
  const bottomFraction = (box.originY + box.height) / frameH;
  const label = d.categories[0]?.categoryName ?? "";
  const isGroundHazard = GROUND_HAZARD_LABELS.has(label);

  if (areaFraction > STOP_AREA_FRACTION || (isGroundHazard && bottomFraction > STOP_BOTTOM_FRACTION)) return "stop";
  if (areaFraction > CAUTION_AREA_FRACTION || (isGroundHazard && bottomFraction > CAUTION_BOTTOM_FRACTION)) {
    return "caution";
  }
  return "none";
}

function directionFor(hazard: VisionResult["hazard_level"], clock: "left" | "ahead" | "right"): VisionResult["direction"] {
  if (hazard === "stop") return "stop";
  if (hazard === "caution") {
    if (clock === "left") return "right";
    if (clock === "right") return "left";
    return "straight";
  }
  return "straight";
}

function messageFor(label: string, hazard: VisionResult["hazard_level"], clock: "left" | "ahead" | "right"): string {
  const where = clock === "ahead" ? "ahead" : `on your ${clock}`;
  if (hazard === "stop") return `Stop — ${label} right ${where === "ahead" ? "ahead" : where}.`;
  if (hazard === "caution") {
    const swing = clock === "left" ? "swing right" : clock === "right" ? "swing left" : "go carefully";
    return `${label[0].toUpperCase()}${label.slice(1)} ${where} — ${swing}.`;
  }
  return "Clear, keep going straight.";
}

// Deliberately NOT "Clear, keep going straight" — EfficientDet-Lite0 is a
// COCO-90 detector with no concept of stairs, curbs, drop-offs, walls, or
// doorways. An empty detection list means "no COCO object found", not "path
// confirmed safe" — asserting "clear" here would be the exact hallucinated
// all-clear the old cloud prompt was rejected for producing (see
// api/vision/route.ts's dropped-context note). The caller must not speak
// this message; sonar (which does classify stairs/wall/doorway) owns the
// all-clear signal by staying silent.
// Not spoken (the caller gates speech on hazard_level !== "none"), but shown
// in the on-screen status bar, so it's worded as a limitation, not a
// guarantee.
const NONE_RESULT: VisionResult = {
  scene: "no object detected by camera",
  hazard_level: "none",
  direction: "straight",
  message: "No object detected — sonar covers hazards the camera can't classify.",
};

let frameCount = 0;
let totalMs = 0;

/**
 * On-device replacement for the old cloud-VLM narration loop: runs a
 * MediaPipe object detector (GPU-delegated where available) directly against
 * the live video element, no network round-trip, no per-frame upload. Not as
 * descriptive as a full vision-language model (it names objects + rough
 * position, not full scene understanding), but it's fast, free, and works
 * with zero connectivity — which is what the reflex/narration loop actually
 * needs. `askAboutScene` (the on-demand Q&A path) still uses the cloud VLM
 * since open-ended questions need real language understanding.
 */
export async function describeSceneOnDevice(video: HTMLVideoElement): Promise<VisionResult> {
  if (video.videoWidth === 0 || video.videoHeight === 0) {
    throw new Error("Camera feed not ready yet…");
  }

  const detector = await loadObjectDetector();
  // detectForVideo is synchronous and runs on the main thread, which the
  // sonar reflex loop (runCycle) also shares — unlike the old cloud call,
  // this can't be assumed non-blocking. Logged every 20 frames so it's easy
  // to check on-device whether this is actually cheap enough at the current
  // VISION_INTERVAL_MS, or whether it's stealing time from sonar's ~350ms cadence.
  const t0 = performance.now();
  const { detections } = detector.detectForVideo(video, t0);
  const elapsed = performance.now() - t0;
  frameCount += 1;
  totalMs += elapsed;
  if (frameCount % 20 === 0) {
    console.debug(`[onDeviceVision] detectForVideo avg ${(totalMs / frameCount).toFixed(1)}ms over ${frameCount} frames`);
  }
  if (detections.length === 0) return NONE_RESULT;

  const frameW = video.videoWidth;
  const frameH = video.videoHeight;

  let best: Detection | null = null;
  let bestScore = -Infinity;
  for (const d of detections) {
    const score = proximityScore(d, frameW, frameH);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  if (!best?.boundingBox) return NONE_RESULT;

  const label = best.categories[0]?.categoryName || "object";
  const centerX = (best.boundingBox.originX + best.boundingBox.width / 2) / frameW;
  const clock = clockDirection(centerX);
  const hazard = hazardFromDetection(best, frameW, frameH);

  return {
    scene: `${label} ${clock === "ahead" ? "ahead" : clock}`,
    hazard_level: hazard,
    direction: directionFor(hazard, clock),
    message: messageFor(label, hazard, clock),
  };
}
