/**
 * The saved WhatsApp emergency number, shared across /infer and /gesture —
 * set once, both pages' SOS triggers (button, shake, shout, gesture) use it.
 * Stored in localStorage only: this app has no accounts/backend, so it's
 * per-device.
 */

const STORAGE_KEY = "echosense-emergency-whatsapp-number";

export function loadEmergencyNumber(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveEmergencyNumber(number: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, number);
  } catch {
    // Storage unavailable — the number just won't persist across reloads.
  }
}
