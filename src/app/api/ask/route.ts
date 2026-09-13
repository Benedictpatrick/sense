import { NextRequest, NextResponse } from "next/server";
import { callNimWithFailover } from "@/lib/nimClient";

export const runtime = "nodejs";

const MAX_TOKENS = 150;

function buildAskPrompt(question: string): string {
  return (
    "You are EchoSense's vision assistant for a blind/low-vision user. They just asked, out loud, " +
    `about what the camera currently sees: "${question}"\n\n` +
    "Answer their actual question directly and concisely, like a sighted friend glancing at the scene " +
    "and answering — one or two short spoken sentences, plain language, no markdown, no JSON, no " +
    "preamble like 'I can see' or 'Looking at the image'. If it's unclear or you can't tell, say so " +
    "briefly and suggest moving the camera closer or reframing. If people are visible, describe them " +
    "only by general position/action, never identity, appearance, or demographics."
  );
}

export async function POST(req: NextRequest) {
  const { image, mediaType, question } = await req.json();

  if (typeof image !== "string" || !image) {
    return NextResponse.json({ error: "Missing image" }, { status: 400 });
  }
  if (typeof question !== "string" || !question.trim()) {
    return NextResponse.json({ error: "Missing question" }, { status: 400 });
  }

  const dataUrl = `data:${mediaType === "image/png" ? "image/png" : "image/jpeg"};base64,${image}`;

  try {
    const result = await callNimWithFailover(dataUrl, buildAskPrompt(question), MAX_TOKENS);

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status === 429 ? 429 : 502 });
    }
    if (!result.text) {
      return NextResponse.json({ error: "No response from model" }, { status: 502 });
    }

    return NextResponse.json({ answer: result.text.trim() });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Ask request failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
