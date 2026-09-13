/**
 * Rear-camera capture for EchoSense vision mode. Frames are pulled from a
 * hidden <video> element onto a canvas and JPEG-encoded for upload — no
 * frames are stored, each call captures the current moment only.
 */

export async function getCameraStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
}

export interface CapturedFrame {
  base64: string;
  mediaType: "image/jpeg";
}

// The live preview stays at full camera resolution for a good on-screen
// image, but the frame actually uploaded to the vision API is downscaled —
// smaller payload uploads and the model processes it faster, meaningfully
// cutting round-trip latency without a real loss in what matters (naming an
// object + its rough position doesn't need full resolution).
const MAX_UPLOAD_DIM = 768;

/** Draws the current video frame to a canvas (downscaled) and returns it as base64 JPEG (no data: prefix). */
export function captureFrame(video: HTMLVideoElement): CapturedFrame | null {
  if (video.videoWidth === 0 || video.videoHeight === 0) return null;

  const scale = Math.min(1, MAX_UPLOAD_DIM / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
  const base64 = dataUrl.split(",")[1] ?? "";
  return { base64, mediaType: "image/jpeg" };
}
