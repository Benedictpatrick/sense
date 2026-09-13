"use client";

import { useEffect, useState } from "react";
import { loadEmergencyNumber, saveEmergencyNumber } from "@/lib/emergencyContact";

/** One saved WhatsApp number, used by every SOS trigger on both /infer and /gesture. */
export default function EmergencyContactSettings() {
  const [number, setNumber] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setNumber(loadEmergencyNumber());
  }, []);

  const onSave = () => {
    saveEmergencyNumber(number.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <section className="rounded-md border border-neutral-200 p-3 text-sm">
      <p className="font-medium text-neutral-700">Emergency WhatsApp contact</p>
      <p className="mt-1 text-xs text-neutral-500">
        With country code, e.g. +1 555 123 4567. SOS (button, shake, shouted &quot;help&quot;, or the help gesture)
        opens WhatsApp pre-addressed to this number with your live location — you still tap Send.
      </p>
      <div className="mt-2 flex gap-2">
        <input
          type="tel"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="+1 555 123 4567"
          className="flex-1 rounded-md border border-neutral-300 px-2 py-2 text-sm"
        />
        <button onClick={onSave} className="rounded-md bg-black px-3 py-2 text-sm font-medium text-white">
          {saved ? "Saved" : "Save"}
        </button>
      </div>
    </section>
  );
}
