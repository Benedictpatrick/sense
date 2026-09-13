import type { CapturedFrame } from "./camera";

export async function askAboutScene(frame: CapturedFrame, question: string): Promise<string> {
  const res = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: frame.base64, mediaType: frame.mediaType, question }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Ask request failed (${res.status})`);
  }

  const data = await res.json();
  return data.answer as string;
}
