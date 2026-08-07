import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

let landmarkerPromise: Promise<HandLandmarker> | null = null;

/** Self-hosted WASM runtime + model asset — works fully offline once cached. */
export function loadHandLandmarker(): Promise<HandLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = FilesetResolver.forVisionTasks("/mediapipe-wasm").then((fileset) =>
      HandLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: "/models/mediapipe/hand_landmarker.task",
        },
        runningMode: "VIDEO",
        numHands: 1,
      })
    );
  }
  return landmarkerPromise;
}

export async function getCameraStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    // Front camera: the signer holds the phone facing themselves.
    video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
  });
}
