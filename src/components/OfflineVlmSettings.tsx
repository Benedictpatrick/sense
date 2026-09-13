"use client";

import { useState } from "react";
import { downloadOfflineVlm, isOfflineVlmReady, type OfflineVlmProgress } from "@/lib/offlineVlm";

interface OfflineVlmSettingsProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}

/**
 * Lets the user opt into downloading the offline captioning model (~400MB,
 * one-time) and switch narration over to it, off the cloud vision model
 * (labeled "Qwen VL 4B" in the UI) that runs by default. Kept opt-in rather
 * than bundled by default — most users won't want a ~400MB download on
 * first visit, and cloud vision covers the common case (with actual
 * internet).
 */
export default function OfflineVlmSettings({ enabled, onEnabledChange }: OfflineVlmSettingsProps) {
  const [status, setStatus] = useState<"idle" | "downloading" | "ready" | "error">(
    isOfflineVlmReady() ? "ready" : "idle",
  );
  const [progress, setProgress] = useState<OfflineVlmProgress | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const download = async () => {
    setStatus("downloading");
    setErrorMsg(null);
    try {
      await downloadOfflineVlm((p) => setProgress(p));
      setStatus("ready");
      onEnabledChange(true);
    } catch (e) {
      setStatus("error");
      setErrorMsg(e instanceof Error ? e.message : "Download failed");
    }
  };

  const pct = progress && progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : null;

  return (
    <section className="rounded-md border border-neutral-200 p-3 text-sm">
      <p className="font-medium text-neutral-700">Offline vision AI (experimental)</p>
      <p className="mt-1 text-xs text-neutral-500">
        A separate on-device captioning model (~400MB, one-time download, then works with zero internet) instead of
        the cloud vision model. It only narrates — it can&apos;t call a hazard the way cloud vision does, so with
        this on, sonar&apos;s vibration/LEDs (and a spoken stairs warning) become your only hazard signal.
      </p>

      {status === "idle" && (
        <button
          onClick={download}
          className="mt-2 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium"
        >
          Download offline vision AI
        </button>
      )}

      {status === "downloading" && (
        <div className="mt-2">
          <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-100">
            <div className="h-2 rounded-full bg-black transition-[width]" style={{ width: `${pct ?? 5}%` }} />
          </div>
          <p className="mt-1 text-xs text-neutral-500">
            {pct !== null ? `Downloading… ${pct}%` : "Downloading…"} — keep this tab open.
          </p>
        </div>
      )}

      {status === "error" && (
        <div className="mt-2">
          <p className="text-xs text-red-600">{errorMsg}</p>
          <button
            onClick={download}
            className="mt-2 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium"
          >
            Retry download
          </button>
        </div>
      )}

      {status === "ready" && (
        <label className="mt-2 flex items-center gap-2 text-xs text-neutral-700">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onEnabledChange(e.target.checked)}
            className="h-4 w-4"
          />
          Use offline AI model for narration instead of the cloud vision model
        </label>
      )}
    </section>
  );
}
