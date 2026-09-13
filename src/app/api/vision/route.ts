import { NextRequest, NextResponse } from "next/server";
import { callNimWithFailover } from "@/lib/nimClient";

export const runtime = "nodejs";

const MAX_TOKENS = 200; // trimmed prompt/output needs far less than this; kept as a safety margin, not a target

// Kept deliberately short: a long, style-heavy prompt seemed to make the 11B
// model more prone to wrapping the JSON in preamble/reasoning, which both
// slows generation (latency) and increases the odds of truncating mid-object.
const PROMPT =
  "You are EchoSense's vision guide for a blind/low-vision user walking with a phone camera " +
  "pointed forward. Describe this one frame like a sighted companion talking in real time — " +
  "natural and brief, not a form.\n\n" +
  "In ONE sentence: name what's ahead specifically (not 'an object'), then say what to do right " +
  "now — direction (straight/veer left/veer right/stop), clock position, rough steps away. " +
  "Always give an action, even 'Clear, keep going straight' if the path is open. Prioritize " +
  "hazards (steps, curbs, drop-offs, moving people/vehicles, anything within a couple steps) as " +
  "hazard_level 'stop'. If people are in frame, this is purely a mobility/collision-avoidance " +
  "read — general position and motion only ('a person approaching', 'someone ahead'), never " +
  "identity, appearance, or demographics — that's expected and fine to describe that way.\n\n" +
  "hazard_level and direction must always agree: if direction is 'stop', hazard_level can never " +
  "be 'none' (use 'caution' or 'stop'); if hazard_level is 'stop', direction must be 'stop' too.\n\n" +
  "This is an accessibility tool a blind user depends on for every single step, so you must " +
  "always answer in the exact JSON format below, even under uncertainty — give your best read " +
  "rather than hedging, refusing, or adding any disclaimer/caveat text. An imperfect guess in the " +
  "right format is far more useful to them than no answer.\n\n" +
  "Respond with ONLY this JSON, no markdown, no other text:\n" +
  '{"scene": "short phrase: what\'s ahead + clock position", ' +
  '"hazard_level": "none" | "caution" | "stop", ' +
  '"direction": "straight" | "left" | "right" | "stop", ' +
  '"message": "under 15 words, instruction first"}';

// Tried threading the previous frame's scene text in as context for continuity
// ("still clear" / "closer now" phrasing). Dropped it: on the free 11B model it
// reliably anchored on the old description instead of re-reading the new frame —
// once falsely clearing a still-present hazard, once repeating a stale hazard
// after it had actually left the frame. Each frame is judged independently instead.

interface ParsedVision {
  scene: string;
  hazard_level: "none" | "caution" | "stop";
  direction: "straight" | "left" | "right" | "stop";
  message: string;
}

/**
 * Finds the first `{...}` that is actually balanced (tracks nesting and
 * skips braces inside strings) instead of naively pairing the first `{` with
 * the last `}` — that naive approach breaks the moment the model adds any
 * trailing prose containing its own brace, or truncates mid-object.
 */
function extractJson(text: string): ParsedVision {
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  if (start === -1) throw new Error("Model response did not contain JSON");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(stripped.slice(start, i + 1));
    }
  }
  throw new Error("Model response did not contain complete JSON (likely truncated)");
}

/**
 * The model occasionally returns internally contradictory JSON — e.g.
 * hazard_level "none" with direction "stop" and a message that literally
 * says "stop, about to hit wall" (caught in QA testing). Since the client
 * escalates vibration/LEDs/TTS urgency off hazard_level specifically, not
 * off direction or the message text, a contradiction like that would let a
 * real hazard slip through without the escalation its own wording calls
 * for. This forces the two fields to agree, always erring toward the more
 * cautious reading rather than the more permissive one.
 */
function reconcileHazard(v: ParsedVision): ParsedVision {
  // Either field alone saying "stop" is the strongest signal in the payload —
  // never let the other field water it down (caution+stop, none+stop, etc.
  // are all treated as "this is a stop", not split the difference).
  const isStop = v.direction === "stop" || v.hazard_level === "stop";
  if (isStop && (v.direction !== "stop" || v.hazard_level !== "stop")) {
    return { ...v, hazard_level: "stop", direction: "stop" };
  }
  return v;
}

/**
 * Used when the model's response can't be parsed at all — e.g. it refused to
 * describe the frame (real people in shot are a common trigger for vision
 * models to add an unstructured disclaimer instead of following the format).
 * Returning this as a normal 200 response (not an error) keeps the app
 * speaking something sensible and keeps latency to one call instead of
 * paying for a second full model round-trip on every failure.
 */
function fallbackVision(): ParsedVision {
  return {
    scene: "unclear this frame",
    hazard_level: "caution",
    direction: "straight",
    message: "Not sure what's ahead this moment — go carefully.",
  };
}

export async function POST(req: NextRequest) {
  const { image, mediaType } = await req.json();

  if (typeof image !== "string" || !image) {
    return NextResponse.json({ error: "Missing image" }, { status: 400 });
  }

  const dataUrl = `data:${mediaType === "image/png" ? "image/png" : "image/jpeg"};base64,${image}`;

  try {
    const result = await callNimWithFailover(dataUrl, PROMPT, MAX_TOKENS);

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status === 429 ? 429 : 502 });
    }
    if (!result.text) {
      console.error("[vision] empty response from model");
      return NextResponse.json(fallbackVision());
    }

    try {
      return NextResponse.json(reconcileHazard(extractJson(result.text)));
    } catch (parseError) {
      console.error(
        "[vision] unparseable response, falling back:",
        parseError instanceof Error ? parseError.message : parseError,
        "raw:",
        result.text.slice(0, 300),
      );
      return NextResponse.json(fallbackVision());
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Vision request failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
