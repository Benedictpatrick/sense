import { openDB, type DBSchema } from "idb";

export const OBSTACLE_LABELS = ["wall", "person", "doorway", "stairs", "none"] as const;
export type ObstacleLabel = (typeof OBSTACLE_LABELS)[number];

export interface EchoSample {
  id: string;
  createdAt: number;
  label: ObstacleLabel;
  groundTruthDistanceCm: number;
  sampleRate: number;
  // Raw captured microphone window (post-emission), used as CNN training input.
  waveform: number[];
  estimatedDistanceM: number;
  peakCorrelation: number;
  deviceInfo: string;
  notes?: string;
}

interface AbleMindDB extends DBSchema {
  echoSamples: {
    key: string;
    value: EchoSample;
    indexes: { "by-createdAt": number; "by-label": string };
  };
}

let dbPromise: ReturnType<typeof openDB<AbleMindDB>> | null = null;

function getDb() {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is not available in this environment");
  }
  if (!dbPromise) {
    dbPromise = openDB<AbleMindDB>("ablemind-echosense", 1, {
      upgrade(db) {
        const store = db.createObjectStore("echoSamples", { keyPath: "id" });
        store.createIndex("by-createdAt", "createdAt");
        store.createIndex("by-label", "label");
      },
    });
  }
  return dbPromise;
}

export async function saveSample(sample: EchoSample): Promise<void> {
  const db = await getDb();
  await db.put("echoSamples", sample);
}

export async function getAllSamples(): Promise<EchoSample[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex("echoSamples", "by-createdAt");
  return all.reverse();
}

export async function deleteSample(id: string): Promise<void> {
  const db = await getDb();
  await db.delete("echoSamples", id);
}

export async function clearAllSamples(): Promise<void> {
  const db = await getDb();
  await db.clear("echoSamples");
}

export async function countByLabel(): Promise<Record<string, number>> {
  const all = await getAllSamples();
  const counts: Record<string, number> = {};
  for (const s of all) {
    counts[s.label] = (counts[s.label] ?? 0) + 1;
  }
  return counts;
}
