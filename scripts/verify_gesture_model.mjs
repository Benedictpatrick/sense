import * as tf from "@tensorflow/tfjs";
import fs from "node:fs";

const dir = "public/models/gesture-alphabet";
const modelJson = JSON.parse(fs.readFileSync(`${dir}/model.json`, "utf-8"));
const weightData = fs.readFileSync(`${dir}/group1-shard1of1.bin`);
const labels = JSON.parse(fs.readFileSync(`${dir}/labels.json`, "utf-8"));

const io = {
  load: async () => ({
    modelTopology: modelJson.modelTopology,
    weightSpecs: modelJson.weightsManifest[0].weights,
    weightData: weightData.buffer.slice(weightData.byteOffset, weightData.byteOffset + weightData.byteLength),
    format: modelJson.format,
    generatedBy: modelJson.generatedBy,
    convertedBy: modelJson.convertedBy,
  }),
};

const model = await tf.loadLayersModel(io);
console.log("Model loaded OK. Input shape:", model.inputs[0].shape, "Labels:", labels.length);

const input = tf.randomUniform([1, 28, 28, 1]);
const output = model.predict(input);
const probs = await output.data();
console.log("Prediction ran OK. Sum of probs (should be ~1):", Array.from(probs).reduce((a, b) => a + b, 0).toFixed(3));
