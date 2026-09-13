/**
 * Storage + helpers for the test-run logger (blindfold obstacle-course
 * testing). Kept separate from the live sonar/vision state in /infer since
 * it's an independent tool, not part of the sense/infer/act loop.
 */

export type RunLabel = "baseline" | "assisted";

export interface TestEvent {
  type: "collision" | "near-miss";
  atMs: number; // ms since run start
}

export interface TestRun {
  id: string;
  label: RunLabel;
  startedAt: number; // epoch ms
  endedAt: number | null;
  events: TestEvent[];
}

const STORAGE_KEY = "echosense-test-runs";

export function loadRuns(): TestRun[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as TestRun[]) : [];
  } catch {
    return [];
  }
}

export function saveRuns(runs: TestRun[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(runs));
  } catch {
    // storage full/unavailable — test data just won't persist across reloads
  }
}

export function runDurationMs(run: TestRun): number {
  return (run.endedAt ?? Date.now()) - run.startedAt;
}

export function countEvents(run: TestRun, type: TestEvent["type"]): number {
  return run.events.filter((e) => e.type === type).length;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
