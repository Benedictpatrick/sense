/**
 * Shared SOS engine — the actual siren/vibrate/LED/location/WhatsApp logic,
 * usable from any page (the manual button + shake on /infer, and the
 * shouted "help" / "help" gesture on /gesture). One implementation so the
 * behavior is identical no matter which trigger fired it.
 */

import { getSharedLedDevice } from "./ble";
import { loadEmergencyNumber } from "./emergencyContact";
import { getLocationLink, openWhatsApp, shareEmergency, startSiren } from "./sos";
import { speak } from "./tts";

let active = false;
let stopSirenFn: (() => void) | null = null;
const listeners = new Set<(active: boolean) => void>();

export function isSosActive(): boolean {
  return active;
}

/** Returns an unsubscribe function. */
export function onSosChange(fn: (active: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) fn(active);
}

export async function fireSos(onStatus?: (message: string) => void): Promise<void> {
  if (active) return;
  active = true;
  notify();

  speak("S O S activated. Getting your location now.", "urgent");
  if ("vibrate" in navigator) navigator.vibrate([300, 100, 300, 100, 300, 100, 300]);
  stopSirenFn = startSiren();

  const led = getSharedLedDevice();
  if (led.connected) led.send("sos", 0);

  onStatus?.("Getting your location…");
  try {
    const { mapsUrl, accuracyM } = await getLocationLink();
    const message = `EMERGENCY — I need help. My location: ${mapsUrl}`;
    const number = loadEmergencyNumber();

    if (number) {
      onStatus?.(`Location ready (±${accuracyM}m) — opening WhatsApp…`);
      openWhatsApp(number, message);
      onStatus?.("WhatsApp opened, pre-filled — tap Send.");
    } else {
      onStatus?.(`Location ready (±${accuracyM}m) — opening share…`);
      const result = await shareEmergency(message);
      onStatus?.(
        result === "shared"
          ? "Location shared."
          : result === "sms-fallback"
            ? "Opened your SMS app with the location — pick a contact and send."
            : `Could not open share automatically. Location: ${mapsUrl}`,
      );
    }
  } catch (e) {
    onStatus?.(e instanceof Error ? e.message : "Could not get your location");
  }
}

export function cancelSos(): void {
  if (!active) return;
  active = false;
  notify();
  stopSirenFn?.();
  stopSirenFn = null;
  if ("vibrate" in navigator) navigator.vibrate(0);
  const led = getSharedLedDevice();
  if (led.connected) led.send("none", 0);
  speak("SOS cancelled.", "urgent");
}
