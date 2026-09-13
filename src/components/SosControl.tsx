"use client";

import { useEffect, useRef, useState } from "react";
import { cancelSos, fireSos, isSosActive, onSosChange } from "@/lib/sosService";
import { speak } from "@/lib/tts";

const HOLD_MS = 2000; // press-and-hold duration to arm/disarm via the button
const SHAKE_ARM_MS = 3000; // spoken/vibrated countdown after a shake before SOS actually fires
const SHAKE_THRESHOLD = 25; // m/s^2 combined acceleration to count as one "shake peak"
const SHAKE_PEAKS_NEEDED = 3; // this many peaks within the window = a deliberate shake, not a stumble
const SHAKE_WINDOW_MS = 1500;
const SHAKE_PEAK_MIN_GAP_MS = 200; // devicemotion fires at ~60Hz — without this, one bump produces many samples that all count as separate "peaks"

type Phase = "idle" | "arming" | "active";

interface SosControlProps {
  /** Mutated directly so the sonar loop's own LED writes can pause while SOS owns the LEDs. */
  sosActiveRef: React.RefObject<boolean>;
}

/**
 * Emergency SOS button/shake trigger for /infer. The actual siren/LED/
 * location/WhatsApp logic lives in lib/sosService — shared with the voice
 * "shout help" and gesture triggers on /gesture — this component is just the
 * touch-and-motion input surface, designed for a user who may not be able to
 * see the screen or call out for help: trigger is press-and-hold at a fixed
 * screen position (findable by feel) or a deliberate shake, and confirmation
 * is spoken + vibrated, not just shown on screen.
 */
export default function SosControl({ sosActiveRef }: SosControlProps) {
  const [phase, setPhase] = useState<Phase>(isSosActive() ? "active" : "idle");
  const [countdown, setCountdown] = useState(0);
  const [locationStatus, setLocationStatus] = useState<string | null>(null);
  const [motionPermissionNeeded, setMotionPermissionNeeded] = useState(false);

  const holdTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const shakePeaksRef = useRef<number[]>([]);
  // devicemotion is a raw window listener attached once on mount (see effect
  // below) — it must never read `phase` directly, only this ref, or its
  // closure freezes at whatever phase existed at mount time forever.
  const phaseRef = useRef<Phase>(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const clearArming = () => {
    if (armTimeoutRef.current) clearTimeout(armTimeoutRef.current);
    if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    armTimeoutRef.current = null;
    countdownIntervalRef.current = null;
  };

  const activate = () => {
    clearArming();
    setPhase("active");
    sosActiveRef.current = true;
    setLocationStatus("Getting your location…");
    fireSos(setLocationStatus);
  };

  const deactivate = () => {
    clearArming();
    if (holdTimeoutRef.current) {
      clearTimeout(holdTimeoutRef.current);
      holdTimeoutRef.current = null;
    }
    setPhase("idle");
    sosActiveRef.current = false;
    setLocationStatus(null);
    cancelSos();
  };

  const startArming = () => {
    if (phaseRef.current !== "idle") return;
    setPhase("arming");
    let remaining = Math.round(SHAKE_ARM_MS / 1000);
    setCountdown(remaining);
    speak(`SOS in ${remaining}. Tap the button to cancel.`, "urgent");
    if ("vibrate" in navigator) navigator.vibrate(150);
    countdownIntervalRef.current = setInterval(() => {
      remaining -= 1;
      setCountdown(remaining);
      if ("vibrate" in navigator) navigator.vibrate(150);
    }, 1000);
    armTimeoutRef.current = setTimeout(() => {
      clearArming();
      activate();
    }, SHAKE_ARM_MS);
  };

  // Button: press-and-hold to arm (idle) or disarm (active); a single tap
  // during the shake countdown cancels immediately. No click handler at all —
  // relying on click-after-release would fire right after a successful hold
  // and immediately cancel the SOS it just triggered.
  const onPressStart = () => {
    if (phase === "arming") {
      deactivate();
      return;
    }
    const action = phase === "active" ? deactivate : activate;
    holdTimeoutRef.current = setTimeout(action, HOLD_MS);
  };
  const onPressEnd = () => {
    if (holdTimeoutRef.current) {
      clearTimeout(holdTimeoutRef.current);
      holdTimeoutRef.current = null;
    }
  };

  function handleMotion(e: DeviceMotionEvent) {
    if (phaseRef.current !== "idle") return; // don't even accumulate peaks unless idle — never re-trigger while arming/active

    const a = e.accelerationIncludingGravity;
    if (!a || a.x === null || a.y === null || a.z === null) return;
    const magnitude = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    if (magnitude < SHAKE_THRESHOLD) return;

    const now = Date.now();
    const peaks = shakePeaksRef.current;
    // devicemotion fires at ~60Hz — without a minimum gap, one bump produces
    // many samples above threshold within milliseconds, each counting as a
    // separate "peak" and satisfying SHAKE_PEAKS_NEEDED from a single jolt.
    if (peaks.length > 0 && now - peaks[peaks.length - 1] < SHAKE_PEAK_MIN_GAP_MS) return;

    shakePeaksRef.current = [...peaks, now].filter((t) => now - t < SHAKE_WINDOW_MS);
    if (shakePeaksRef.current.length >= SHAKE_PEAKS_NEEDED) {
      shakePeaksRef.current = [];
      startArming();
    }
  }

  // Keep local UI phase in sync with the shared service (defensive — e.g. if
  // SOS somehow got cancelled from elsewhere while this page is mounted).
  useEffect(() => {
    return onSosChange((active) => {
      sosActiveRef.current = active;
      setPhase((p) => (active ? "active" : p === "active" ? "idle" : p));
      if (!active) setLocationStatus(null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const RequestPermissionFn = (
      window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }
    ).DeviceMotionEvent?.requestPermission;

    if (typeof RequestPermissionFn === "function") {
      setMotionPermissionNeeded(true);
      return;
    }
    window.addEventListener("devicemotion", handleMotion);
    return () => window.removeEventListener("devicemotion", handleMotion);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      clearArming();
      if (holdTimeoutRef.current) clearTimeout(holdTimeoutRef.current);
      window.removeEventListener("devicemotion", handleMotion);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestMotionPermission = async () => {
    const RequestPermissionFn = (
      window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }
    ).DeviceMotionEvent?.requestPermission;
    if (!RequestPermissionFn) return;
    try {
      const result = await RequestPermissionFn();
      if (result === "granted") {
        setMotionPermissionNeeded(false);
        window.addEventListener("devicemotion", handleMotion);
      }
    } catch {
      // Permission denied — shake trigger just won't be available; the button still works.
    }
  };

  return (
    <>
      {phase === "active" && <div className="fixed inset-0 z-40 animate-pulse bg-red-600/70" aria-hidden="true" />}

      {motionPermissionNeeded && phase === "idle" && (
        <button
          onClick={requestMotionPermission}
          className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-full bg-neutral-900 px-4 py-2 text-xs text-white shadow-lg"
        >
          Enable shake-to-SOS
        </button>
      )}

      {locationStatus && (
        <div className="fixed inset-x-0 bottom-16 z-50 bg-black/80 px-4 py-2 text-center text-xs text-white">
          {locationStatus}
        </div>
      )}

      <button
        onPointerDown={onPressStart}
        onPointerUp={onPressEnd}
        onPointerLeave={onPressEnd}
        onPointerCancel={onPressEnd}
        className={`fixed inset-x-0 bottom-0 z-50 w-full py-6 text-center text-lg font-bold uppercase tracking-wide text-white shadow-[0_-4px_12px_rgba(0,0,0,0.3)] ${
          phase === "active" ? "animate-pulse bg-red-700" : phase === "arming" ? "bg-orange-600" : "bg-red-600"
        }`}
      >
        {phase === "active" ? "SOS ACTIVE — hold to cancel" : phase === "arming" ? `SOS in ${countdown}… tap to cancel` : "Hold for SOS"}
      </button>
    </>
  );
}
