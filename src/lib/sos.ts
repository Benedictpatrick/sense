/**
 * Emergency SOS helpers: siren audio, geolocation, and native share/SMS
 * handoff. There's no backend here to actually send an SMS or place a call —
 * the phone's own share sheet (or its SMS app as a fallback) does the real
 * sending, using whatever contact/app the user already has set up.
 */

export function startSiren(): () => void {
  const AudioContextCtor =
    window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioContextCtor();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "square";
  gain.gain.value = 0.3;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();

  // Classic two-tone siren: sweep the frequency up and down repeatedly.
  let rising = true;
  let freq = 600;
  const sweep = setInterval(() => {
    freq += rising ? 40 : -40;
    if (freq >= 1000) rising = false;
    if (freq <= 600) rising = true;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
  }, 40);

  return () => {
    clearInterval(sweep);
    osc.stop();
    ctx.close();
  };
}

export interface LocationResult {
  mapsUrl: string;
  accuracyM: number;
}

export function getLocationLink(): Promise<LocationResult> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Location isn't supported on this device"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        resolve({
          mapsUrl: `https://maps.google.com/?q=${latitude},${longitude}`,
          accuracyM: Math.round(accuracy),
        });
      },
      (err) => reject(new Error(err.message || "Could not get your location")),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  });
}

/**
 * Opens a chat pre-addressed to a specific number via WhatsApp's click-to-chat
 * deep link, pre-filled with the message. WhatsApp doesn't allow sending
 * without the user tapping Send themselves (anti-spam design) — this gets
 * them to that one tap, pre-addressed, instead of having to pick a contact.
 *
 * Uses a same-tab navigation (location.href), NOT window.open(). SOS is
 * triggered from a setTimeout (press-and-hold) or a devicemotion event
 * (shake) — neither counts as a direct user gesture, and fireSos also awaits
 * geolocation first — so window.open() gets silently popup-blocked with no
 * error in that context. A plain navigation is never blocked regardless of
 * gesture/timing, which is what a normal <a href> click to wa.me does anyway.
 */
export function openWhatsApp(number: string, message: string): void {
  const digits = number.replace(/\D/g, "");
  const url = `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
  window.location.href = url;
}

export type ShareOutcome = "shared" | "sms-fallback" | "failed";

export async function shareEmergency(message: string): Promise<ShareOutcome> {
  if (navigator.share) {
    try {
      await navigator.share({ title: "Emergency — need help", text: message });
      return "shared";
    } catch {
      // User cancelled the native share sheet, or it errored — fall through to SMS.
    }
  }
  try {
    window.location.href = `sms:?body=${encodeURIComponent(message)}`;
    return "sms-fallback";
  } catch {
    return "failed";
  }
}
