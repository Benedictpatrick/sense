"use client";

import { useEffect, useRef, useState } from "react";
import {
  countEvents,
  formatDuration,
  loadRuns,
  runDurationMs,
  saveRuns,
  type RunLabel,
  type TestRun,
} from "@/lib/testLog";

/**
 * Stopwatch + tap-to-log tool for blindfold obstacle-course testing: a
 * spotter taps "collision" / "near miss" while someone walks a course with
 * and without EchoSense, producing real before/after numbers for the pitch
 * instead of just describing the feature. Runs persist to localStorage so a
 * page reload mid-event doesn't lose test data.
 */
export default function TestRunLogger() {
  const [runs, setRuns] = useState<TestRun[]>([]);
  const [activeRun, setActiveRun] = useState<TestRun | null>(null);
  const [pendingLabel, setPendingLabel] = useState<RunLabel>("baseline");
  const [, setTick] = useState(0); // forces a re-render every second for the live timer
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setRuns(loadRuns());
  }, []);

  useEffect(() => {
    if (activeRun) {
      tickRef.current = setInterval(() => setTick((t) => t + 1), 1000);
    } else if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [activeRun]);

  const startRun = () => {
    setActiveRun({
      id: crypto.randomUUID(),
      label: pendingLabel,
      startedAt: Date.now(),
      endedAt: null,
      events: [],
    });
  };

  const logEvent = (type: "collision" | "near-miss") => {
    setActiveRun((run) => {
      if (!run) return run;
      return { ...run, events: [...run.events, { type, atMs: Date.now() - run.startedAt }] };
    });
  };

  const endRun = () => {
    setActiveRun((run) => {
      if (!run) return null;
      const finished = { ...run, endedAt: Date.now() };
      setRuns((prev) => {
        const next = [...prev, finished];
        saveRuns(next);
        return next;
      });
      return null;
    });
  };

  const clearHistory = () => {
    setRuns([]);
    saveRuns([]);
  };

  return (
    <section className="rounded-md border border-neutral-300 p-4">
      <p className="text-xs uppercase tracking-wide text-neutral-500">Test run logger</p>
      <p className="mt-1 text-xs text-neutral-500">
        For obstacle-course walk tests (a spotter taps as you go) — produces real numbers for the pitch.
      </p>

      {!activeRun ? (
        <div className="mt-3 flex items-center gap-2">
          <select
            value={pendingLabel}
            onChange={(e) => setPendingLabel(e.target.value as RunLabel)}
            className="rounded-md border border-neutral-300 px-2 py-2 text-sm"
          >
            <option value="baseline">Baseline (no assist)</option>
            <option value="assisted">With EchoSense</option>
          </select>
          <button onClick={startRun} className="flex-1 rounded-md bg-black px-3 py-2 text-sm font-medium text-white">
            Start run
          </button>
        </div>
      ) : (
        <div className="mt-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">
              {activeRun.label === "baseline" ? "Baseline run" : "Assisted run"} —{" "}
              {formatDuration(Date.now() - activeRun.startedAt)}
            </p>
            <button onClick={endRun} className="text-xs text-red-600 underline">
              End run
            </button>
          </div>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => logEvent("collision")}
              className="flex-1 rounded-md bg-red-600 px-3 py-4 text-sm font-semibold text-white active:bg-red-700"
            >
              Collision ({countEvents(activeRun, "collision")})
            </button>
            <button
              onClick={() => logEvent("near-miss")}
              className="flex-1 rounded-md bg-amber-500 px-3 py-4 text-sm font-semibold text-white active:bg-amber-600"
            >
              Near miss ({countEvents(activeRun, "near-miss")})
            </button>
          </div>
        </div>
      )}

      {runs.length > 0 && (
        <div className="mt-4 border-t border-neutral-200 pt-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-neutral-700">Run history</p>
            <button onClick={clearHistory} className="text-xs text-neutral-400 underline">
              Clear
            </button>
          </div>
          <div className="mt-2 flex flex-col gap-1">
            {runs.map((run) => (
              <div key={run.id} className="flex items-center justify-between text-xs text-neutral-600">
                <span>{run.label === "baseline" ? "Baseline" : "Assisted"}</span>
                <span>{formatDuration(runDurationMs(run))}</span>
                <span className="text-red-600">{countEvents(run, "collision")} collisions</span>
                <span className="text-amber-600">{countEvents(run, "near-miss")} near misses</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
