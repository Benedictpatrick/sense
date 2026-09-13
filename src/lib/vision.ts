import type { CapturedFrame } from "./camera";

export interface VisionResult {
  scene: string;
  hazard_level: "none" | "caution" | "stop";
  direction: "straight" | "left" | "right" | "stop";
  message: string;
}

export class VisionRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "VisionRequestError";
  }
}

const REQUEST_TIMEOUT_MS = 10000;

export async function describeScene(frame: CapturedFrame): Promise<VisionResult> {
  const controller = new AbortController();
  // Without this, a slow/hung request (weak mobile upload, slow model
  // response) never resolves OR rejects — the loop just stalls forever with
  // nothing on screen ever updating, which looks exactly like "idle."
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch("/api/vision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: frame.base64, mediaType: frame.mediaType }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new VisionRequestError(body.error || `Vision request failed (${res.status})`, res.status);
    }

    return res.json();
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new VisionRequestError("Vision request timed out — retrying.", 408);
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}
