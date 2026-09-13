"use client";

import { useEffect, useState } from "react";
import { cancelSos, isSosActive, onSosChange } from "@/lib/sosService";

/**
 * Shows SOS active/cancel state on pages that trigger it via voice or
 * gesture rather than a dedicated hold/shake button (see SosControl for
 * that, used on /infer). Subscribes to the same shared service, so it stays
 * in sync no matter which page or trigger fired it.
 */
export default function SosStatusOverlay() {
  const [active, setActive] = useState(isSosActive());

  useEffect(() => onSosChange(setActive), []);

  if (!active) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 animate-pulse bg-red-600/70" aria-hidden="true" />
      <button
        onClick={cancelSos}
        className="fixed inset-x-0 bottom-0 z-50 w-full animate-pulse bg-red-700 py-6 text-center text-lg font-bold uppercase tracking-wide text-white shadow-[0_-4px_12px_rgba(0,0,0,0.3)]"
      >
        SOS ACTIVE — tap to cancel
      </button>
    </>
  );
}
