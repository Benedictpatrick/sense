import { ObjectDetector, FilesetResolver } from "@mediapipe/tasks-vision";

let detectorPromise: Promise<ObjectDetector> | null = null;

/**
 * Self-hosted WASM runtime + model asset, GPU-delegated — runs entirely on
 * the phone's own GPU (e.g. Adreno on Snapdragon), no network round-trip.
 * Falls back to the CPU delegate if the GPU path isn't available on this
 * device/browser combo, rather than failing outright.
 */
export function loadObjectDetector(): Promise<ObjectDetector> {
  if (!detectorPromise) {
    detectorPromise = FilesetResolver.forVisionTasks("/mediapipe-wasm").then(async (fileset) => {
      try {
        return await ObjectDetector.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: "/models/mediapipe/efficientdet_lite0.tflite",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          maxResults: 5,
          scoreThreshold: 0.4,
        });
      } catch (e) {
        console.warn("[objectDetector] GPU delegate unavailable, falling back to CPU:", e);
        return ObjectDetector.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: "/models/mediapipe/efficientdet_lite0.tflite",
            delegate: "CPU",
          },
          runningMode: "VIDEO",
          maxResults: 5,
          scoreThreshold: 0.4,
        });
      }
    });
    detectorPromise.catch(() => {
      detectorPromise = null;
    });
  }
  return detectorPromise;
}
