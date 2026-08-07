import * as tf from "@tensorflow/tfjs";

let modelPromise: Promise<tf.LayersModel> | null = null;
let labelsPromise: Promise<string[]> | null = null;

export function loadModel(): Promise<tf.LayersModel> {
  if (!modelPromise) {
    modelPromise = tf.loadLayersModel("/models/echosense/model.json");
  }
  return modelPromise;
}

export function loadLabels(): Promise<string[]> {
  if (!labelsPromise) {
    labelsPromise = fetch("/models/echosense/labels.json").then((r) => r.json());
  }
  return labelsPromise;
}

export interface Prediction {
  label: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export async function classify(model: tf.LayersModel, labels: string[], features: Float32Array): Promise<Prediction> {
  const input = tf.tensor(features, [1, features.length, 1]);
  const output = model.predict(input) as tf.Tensor;
  const probs = Array.from(await output.data());
  input.dispose();
  output.dispose();

  let maxIdx = 0;
  for (let i = 1; i < probs.length; i++) {
    if (probs[i] > probs[maxIdx]) maxIdx = i;
  }

  const probabilities: Record<string, number> = {};
  labels.forEach((l, i) => (probabilities[l] = probs[i]));

  return { label: labels[maxIdx], confidence: probs[maxIdx], probabilities };
}
