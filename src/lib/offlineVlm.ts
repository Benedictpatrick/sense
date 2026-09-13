import type { VisionResult } from "./vision";

/**
 * Small image-captioning model (ViT encoder + GPT-2 decoder), run entirely
 * in-browser via transformers.js/ONNX Runtime Web. This is a narration
 * source, not a hazard classifier: a caption model has no sense of distance
 * or urgency (a parked car ten meters away and one about to be walked into
 * produce the same caption), so it deliberately never sets hazard_level
 * above "none" — sonar and the on-device object detector are what actually
 * drive vibration/LEDs/urgent speech. This model only speaks what it sees.
 */
const MODEL_ID = "Xenova/vit-gpt2-image-captioning";

export interface OfflineVlmProgress {
  file: string;
  loaded: number;
  total: number;
}

interface CaptionOutput {
  generated_text: string;
}

type CaptionPipeline = (image: string, options?: { max_new_tokens?: number }) => Promise<CaptionOutput[]>;

interface TransformersProgressEvent {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
}

let pipelinePromise: Promise<CaptionPipeline> | null = null;
let ready = false;
let offlineFrameCount = 0;
let offlineTotalMs = 0;

export function isOfflineVlmReady(): boolean {
  return ready;
}

/**
 * Downloads the model (or loads it straight from the browser's HTTP cache if
 * it was already fetched once — transformers.js caches model files itself,
 * so a repeat call after a page reload is fast and offline-safe). Safe to
 * call multiple times; concurrent/repeat calls share the same in-flight
 * download instead of starting a second one.
 *
 * dtype is pinned to "q8" (quantized, ~246MB total across encoder+decoder)
 * explicitly — left unset, transformers.js only defaults to q8 on the wasm
 * backend; on webgpu it defaults to fp32, which is a ~950MB download instead
 * of the size promised in the UI. `device` is pinned to "wasm" to match
 * (the actual default in-browser already, but pinned so it can't silently
 * change).
 *
 * The decoder specifically is fp16, not q8: on-device testing hit an ONNX
 * Runtime Web error ("missing required transposed weight input") from the
 * quantized decoder — its int8 file appears to use MatMulNBits-style block
 * quantization, whose WASM kernel is immature and doesn't reliably run in
 * the browser today. The encoder (a much simpler ViT forward pass) stays
 * q8, which works fine — only the autoregressive GPT-2 decoder hit this.
 * Total download is ~90MB (encoder, q8) + ~310MB (decoder, fp16) ≈ 400MB,
 * not the ~250MB an all-q8 download would have been.
 */
export async function downloadOfflineVlm(onProgress?: (p: OfflineVlmProgress) => void): Promise<void> {
  if (ready) return;
  if (!pipelinePromise) {
    pipelinePromise = import("@huggingface/transformers")
      .then(({ pipeline }) =>
        pipeline("image-to-text", MODEL_ID, {
          // Keyed by transformers.js's internal session name, not the ONNX
          // filename — the vision-encoder-decoder architecture calls the
          // encoder session "model" (see session_config.js), not
          // "encoder_model", even though the downloaded file is named that.
          dtype: { model: "q8", decoder_model_merged: "fp16" },
          device: "wasm",
          progress_callback: (event: TransformersProgressEvent) => {
            if (event.status === "progress" && onProgress) {
              onProgress({ file: event.file ?? "", loaded: event.loaded ?? 0, total: event.total ?? 0 });
            }
          },
        }),
      )
      .then((pipe) => pipe as unknown as CaptionPipeline);
    pipelinePromise.then(
      () => {
        ready = true;
      },
      () => {
        // Let a failed download be retried rather than permanently sticking on "failed".
        pipelinePromise = null;
      },
    );
  }
  await pipelinePromise;
}

// The ViT encoder resizes its input to 224x224 internally regardless of what
// we hand it, so uploading full camera resolution (1280x720, like camera.ts
// sends to the cloud VLM) just spends extra canvas/JPEG-encode time for
// detail the model immediately throws away.
const CAPTURE_DIM = 320;

function captureDataUrl(video: HTMLVideoElement): string | null {
  if (video.videoWidth === 0 || video.videoHeight === 0) return null;
  const scale = Math.min(1, CAPTURE_DIM / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

/**
 * Offline narration alternative to the cloud VLM: generates a free-text
 * caption of the current frame with the downloaded model. Always returns
 * hazard_level "none" / direction "straight" — see the module comment for
 * why this must not drive vibration, LEDs, or urgent speech. The caller
 * (infer/page.tsx) speaks this result's message regardless of hazard_level,
 * unlike the object-detector path where "none" means "nothing to say."
 * Must call `downloadOfflineVlm()` (and await it completing) at least once first.
 */
export async function describeSceneOffline(video: HTMLVideoElement): Promise<VisionResult> {
  if (!ready || !pipelinePromise) {
    throw new Error("Offline vision model isn't downloaded yet.");
  }
  const dataUrl = captureDataUrl(video);
  if (!dataUrl) throw new Error("Camera feed not ready yet…");

  const captioner = await pipelinePromise;
  // Encoder-decoder generation on the wasm backend is far heavier than the
  // object detector's single forward pass, and runs on the same main thread
  // as the sonar reflex loop — log it so it's checkable on-device whether
  // VISION_OFFLINE_VLM_INTERVAL_MS is actually enough headroom, or whether
  // sonar's own cadence (watch adaptiveState.intervalMs) is drifting because
  // of it.
  const t0 = performance.now();
  const [output] = await captioner(dataUrl, { max_new_tokens: 30 });
  offlineFrameCount += 1;
  offlineTotalMs += performance.now() - t0;
  if (offlineFrameCount % 5 === 0) {
    console.debug(
      `[offlineVlm] caption avg ${(offlineTotalMs / offlineFrameCount).toFixed(0)}ms over ${offlineFrameCount} frames`,
    );
  }
  const caption = (output?.generated_text ?? "").trim();
  if (!caption) throw new Error("Offline model returned no caption");

  const sentence = caption.charAt(0).toUpperCase() + caption.slice(1);
  return {
    scene: caption,
    hazard_level: "none",
    direction: "straight",
    message: `${sentence}.`,
  };
}
