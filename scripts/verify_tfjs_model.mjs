import * as tf from "@tensorflow/tfjs";
import fs from "node:fs";

const dir = "public/models/echosense";
const modelJson = JSON.parse(fs.readFileSync(`${dir}/model.json`, "utf-8"));
const weightData = fs.readFileSync(`${dir}/group1-shard1of1.bin`);

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
console.log("Model loaded OK. Input shape:", model.inputs[0].shape);

const input = tf.randomNormal([1, 3000, 1]);
const output = model.predict(input);
const probs = await output.data();
console.log("Prediction ran OK. Output probs:", Array.from(probs).map((p) => p.toFixed(3)));
