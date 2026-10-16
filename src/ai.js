import { config } from './config.js';

/**
 * Calls any OpenAI-compatible chat endpoint (Gemini by default).
 * Swap provider by changing AI_BASE_URL / AI_MODEL / AI_API_KEY only.
 */
export async function chat(messages, { retries = 2 } = {}) {
  const url = `${config.aiBaseUrl.replace(/\/$/, '')}/chat/completions`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.aiApiKey}` },
        body: JSON.stringify({
          model: config.aiModel,
          messages,
          temperature: 0.4,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(config.aiTimeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`AI HTTP ${res.status}: ${await res.text()}`);
        await new Promise(r => setTimeout(r, 800 * 2 ** attempt));
        continue;
      }
      if (!res.ok) {
        // 4xx (bad key, bad model name) won't fix itself — don't retry
        const err = new Error(`AI HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        err.fatal = true;
        throw err;
      }
      const data = await res.json();
      return data.choices?.[0]?.message?.content ?? '';
    } catch (e) {
      lastErr = e;
      if (e.fatal || attempt === retries) break;
      await new Promise(r => setTimeout(r, 800 * 2 ** attempt));
    }
  }
  throw lastErr;
}

/** Parses the model output; tolerates ```json fences and stray text. */
export function parseAiJson(text) {
  const fallback = { reply: String(text ?? '').trim(), action: 'none' };
  if (!text) return { reply: '', action: 'none' };
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) return fallback;
  try {
    const obj = JSON.parse(t.slice(start, end + 1));
    if (typeof obj.reply !== 'string') return fallback;
    if (!['none', 'order', 'handoff'].includes(obj.action)) obj.action = 'none';
    if (obj.action === 'order' && !Array.isArray(obj.order?.items)) obj.action = 'none';
    return obj;
  } catch {
    return fallback;
  }
}
