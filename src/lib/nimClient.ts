/**
 * Shared NVIDIA NIM client with multi-key failover — used by both the
 * continuous-narration route (/api/vision) and the on-demand Q&A route
 * (/api/ask), so the failover logic lives in exactly one place.
 */

export const NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
export const NIM_MODEL = "meta/llama-3.2-11b-vision-instruct";

/** Every configured NVIDIA_API_KEY_* env var, in order — one primary plus any backups. */
export function getApiKeys(): string[] {
  return [process.env.NVIDIA_API_KEY, process.env.NVIDIA_API_KEY_2, process.env.NVIDIA_API_KEY_3].filter(
    (k): k is string => Boolean(k),
  );
}

export interface NimResult {
  text?: string;
  status?: number;
  error?: string;
}

const KEY_TIMEOUT_MS = 8000;

async function callNimWithKey(apiKey: string, dataUrl: string, promptText: string, maxTokens: number): Promise<NimResult> {
  const controller = new AbortController();
  // Without this, a hung request on key 1 never times out server-side (or
  // only does after Vercel's own multi-minute function limit) — the whole
  // point of having backup keys is defeated if failover can't kick in fast.
  const timeoutId = setTimeout(() => controller.abort(), KEY_TIMEOUT_MS);

  try {
    const res = await fetch(NIM_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: NIM_MODEL,
        max_tokens: maxTokens,
        temperature: 0.2,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: promptText },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { status: res.status, error: `NVIDIA NIM request failed (${res.status}): ${body.slice(0, 200)}` };
    }

    const data = await res.json();
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    return { text };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { status: 504, error: "NVIDIA NIM request timed out" };
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Tries each configured key in order. A rate-limited (429) or auth-failed
 * (401/403) key fails over to the next one automatically — the whole point
 * of having a backup key. Any other failure (5xx, network) also tries the
 * next key, but its error is what gets returned if every key is exhausted.
 */
export async function callNimWithFailover(dataUrl: string, promptText: string, maxTokens: number): Promise<NimResult> {
  const keys = getApiKeys();
  if (keys.length === 0) return { status: 500, error: "NVIDIA_API_KEY is not configured" };

  let lastFailure: NimResult | null = null;
  for (let i = 0; i < keys.length; i++) {
    const result = await callNimWithKey(keys[i], dataUrl, promptText, maxTokens);
    if (result.status) {
      if (result.status === 429 || result.status === 401 || result.status === 403) {
        console.error(`[nim] key ${i + 1}/${keys.length} failed (${result.status}), trying next`);
      }
      lastFailure = result;
      continue;
    }
    return result;
  }
  return lastFailure ?? { status: 502, error: "All configured API keys failed" };
}
