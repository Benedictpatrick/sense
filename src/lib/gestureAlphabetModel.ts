import * as tf from "@tensorflow/tfjs";

let modelPromise: Promise<tf.LayersModel> | null = null;
let labelsPromise: Promise<string[]> | null = null;

export function loadAlphabetModel(): Promise<tf.LayersModel> {
  if (!modelPromise) {
    modelPromise = tf.loadLayersModel("/models/gesture-alphabet/model.json");
  }
  return modelPromise;
}

export function loadAlphabetLabels(): Promise<string[]> {
  if (!labelsPromise) {
    labelsPromise = fetch("/models/gesture-alphabet/labels.json").then((r) => r.json());
  }
  return labelsPromise;
}

export interface LetterPrediction {
  letter: string;
  confidence: number;
}

/** Classifies a 28x28 grayscale canvas region (matches the Sign Language MNIST training format). */
export async function classifyLetter(
  model: tf.LayersModel,
  labels: string[],
  canvas: HTMLCanvasElement
): Promise<LetterPrediction> {
  const input = tf.tidy(() => {
    const img = tf.browser.fromPixels(canvas, 1); // grayscale channel
    return img.toFloat().div(255).expandDims(0); // [1, 28, 28, 1]
  });
  const output = model.predict(input) as tf.Tensor;
  const probs = Array.from(await output.data());
  input.dispose();
  output.dispose();

  let maxIdx = 0;
  for (let i = 1; i < probs.length; i++) {
    if (probs[i] > probs[maxIdx]) maxIdx = i;
  }
  return { letter: labels[maxIdx], confidence: probs[maxIdx] };
}
