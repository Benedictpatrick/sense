/**
 * Speaks short guidance messages via the Web Speech API. Sonar (fast,
 * ~350ms) and vision (slow, ~2.5s) both call this, so two independent loops
 * race for the same voice. Three ranked tiers, strictly enforced: a message
 * can only interrupt something already playing if it's ranked equal or
 * higher — "background" (sonar's reflex) can NEVER interrupt anything, even
 * another background message, only ever fill genuine silence. This used to
 * be done with just "normal"/"urgent" and an external `speechSynthesis
 * .speaking` check at the call site, which had a real gap: two "normal"
 * messages (vision's routine narration vs. sonar's old "normal" reflex)
 * would freely cancel each other, so sonar could still clip vision
 * mid-sentence. Speaking state is now tracked internally via utterance
 * events rather than trusting `speechSynthesis.speaking`, which is known to
 * be unreliable on some Android WebViews.
 */

export type SpeechPriority = "background" | "normal" | "urgent";

const RANK: Record<SpeechPriority, number> = { background: 0, normal: 1, urgent: 2 };

let lastSpoken = "";
let currentPriority: SpeechPriority = "background";
let speaking = false;
let speakingSinceMs = 0;

// Safety net: onend/onerror are known to sometimes never fire on mobile
// (Android WebView in particular) — e.g. after the tab backgrounds mid-
// utterance. Without this, `speaking` gets stuck true forever and every
// "normal"-or-lower message is silently dropped from then on, which looks
// exactly like "vision is detecting but never speaking." No real utterance
// from a <20-word message takes anywhere near this long.
const STUCK_SPEECH_TIMEOUT_MS = 12000;

/** `priority` defaults to "normal". "urgent" bypasses repeat-dedup. */
export function speak(message: string, priority: SpeechPriority = "normal"): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  if (!message) return;
  if (priority !== "urgent" && message === lastSpoken) return;

  if (speaking && Date.now() - speakingSinceMs > STUCK_SPEECH_TIMEOUT_MS) {
    speaking = false;
    currentPriority = "background";
  }

  if (speaking) {
    if (RANK[priority] < RANK[currentPriority]) return; // strictly lower priority never interrupts
    if (priority === "background") return; // background never interrupts anything in flight, even itself
  }

  lastSpoken = message;
  currentPriority = priority;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(message);
  utterance.rate = 1.05;
  utterance.onstart = () => {
    speaking = true;
    speakingSinceMs = Date.now();
  };
  utterance.onend = () => {
    speaking = false;
    if (currentPriority === priority) currentPriority = "background";
  };
  utterance.onerror = () => {
    speaking = false;
  };
  window.speechSynthesis.speak(utterance);
}

export function resetSpeechDedup(): void {
  lastSpoken = "";
  currentPriority = "background";
  speaking = false;
}

export function ttsSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}
