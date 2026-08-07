/**
 * Geometric ASL word classifier: turns MediaPipe HandLandmarker's 21 hand
 * landmarks into a small, deterministic set of finger-extension states, then
 * matches known handshapes. No training data needed — every sign here has a
 * genuinely distinct static handshape, chosen deliberately (per the project
 * doc's own guidance: scope the initial vocabulary to a well-defined,
 * high-utility set and treat it as Phase 1 of an extensible system). Signs
 * that require motion (e.g. "thank you", "please") are out of scope for this
 * static-pose approach and are future work, not approximated here.
 */

export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export interface FingerStates {
  thumb: boolean;
  index: boolean;
  middle: boolean;
  ring: boolean;
  pinky: boolean;
}

// MediaPipe Hands landmark indices.
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_PIP = 6;
const INDEX_TIP = 8;
const MIDDLE_PIP = 10;
const MIDDLE_TIP = 12;
const RING_PIP = 14;
const RING_TIP = 16;
const PINKY_MCP = 17;
const PINKY_PIP = 18;
const PINKY_TIP = 20;

function dist(a: Point3D, b: Point3D): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function getFingerStates(landmarks: Point3D[]): FingerStates {
  const wrist = landmarks[WRIST];

  // Straight fingers: tip is farther from the wrist than the corresponding
  // PIP joint. Robust to hand rotation, unlike a raw y-coordinate check.
  const straight = (pip: number, tip: number) => dist(landmarks[tip], wrist) > dist(landmarks[pip], wrist);

  // Thumb moves sideways rather than curling toward the palm, so compare its
  // tip distance from the pinky's base (roughly "across the palm") instead.
  const thumbExtended = dist(landmarks[THUMB_TIP], landmarks[PINKY_MCP]) > dist(landmarks[INDEX_MCP], landmarks[PINKY_MCP]) * 0.9;

  return {
    thumb: thumbExtended,
    index: straight(INDEX_PIP, INDEX_TIP),
    middle: straight(MIDDLE_PIP, MIDDLE_TIP),
    ring: straight(RING_PIP, RING_TIP),
    pinky: straight(PINKY_PIP, PINKY_TIP),
  };
}

export type GestureLabel = "hello" | "yes" | "no" | "i_love_you" | "none";

export const GESTURE_SPEECH: Record<GestureLabel, string> = {
  hello: "Hello",
  yes: "Yes",
  no: "No",
  i_love_you: "I love you",
  none: "",
};

export function classifyGesture(landmarks: Point3D[]): GestureLabel {
  const f = getFingerStates(landmarks);

  if (f.thumb && f.index && f.middle && f.ring && f.pinky) return "hello"; // open palm
  if (!f.thumb && !f.index && !f.middle && !f.ring && !f.pinky) return "yes"; // fist
  if (f.index && f.middle && !f.ring && !f.pinky) return "no"; // index+middle extended
  if (f.thumb && f.index && !f.middle && !f.ring && f.pinky) return "i_love_you"; // ILY handshape

  return "none";
}
