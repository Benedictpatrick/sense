"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getAllSamples, deleteSample, clearAllSamples, type EchoSample } from "@/lib/db";

export default function DatasetPage() {
  const [samples, setSamples] = useState<EchoSample[]>([]);

  const refresh = useCallback(async () => {
    setSamples(await getAllSamples());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(samples, null, 0)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ablemind-echosense-dataset-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDelete = async (id: string) => {
    await deleteSample(id);
    await refresh();
  };

  const handleClear = async () => {
    if (!confirm("Delete ALL collected samples? This cannot be undone.")) return;
    await clearAllSamples();
    await refresh();
  };

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Dataset</h1>
        <Link
          href="/collect"
          className="inline-flex items-center gap-1 rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-100"
        >
          <span aria-hidden="true">←</span> Back to collection
        </Link>
      </header>

      <div className="flex gap-3">
        <button
          onClick={exportJson}
          disabled={samples.length === 0}
          className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          Export as JSON ({samples.length})
        </button>
        <button
          onClick={handleClear}
          disabled={samples.length === 0}
          className="rounded-md border border-red-400 px-4 py-2 text-sm font-medium text-red-600 disabled:opacity-40"
        >
          Clear all
        </button>
      </div>

      <ul className="flex flex-col gap-2">
        {samples.map((s) => (
          <li
            key={s.id}
            className="flex items-center justify-between rounded-md border border-neutral-200 p-3 text-sm"
          >
            <div>
              <p className="font-medium capitalize">
                {s.label} — {s.groundTruthDistanceCm}cm
              </p>
              <p className="text-neutral-500">
                est. {(s.estimatedDistanceM * 100).toFixed(1)}cm · {new Date(s.createdAt).toLocaleString()}
              </p>
            </div>
            <button onClick={() => handleDelete(s.id)} className="text-red-600 underline">
              Delete
            </button>
          </li>
        ))}
        {samples.length === 0 && <p className="text-sm text-neutral-500">No samples yet.</p>}
      </ul>
    </main>
  );
}
